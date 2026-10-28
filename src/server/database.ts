import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import type { ExecutionDetail, ExecutionEvent, ExecutionRecorder, ExecutionRun, ExecutionStep, Workflow } from '../shared';
import type { EmailCursorStore } from './email';

type JsonRow = { flow_json?: string; snapshot_json?: string };
type RunRow = { id: string; workflow_id: string; workflow_name: string; trigger_type: ExecutionRun['trigger']; status: ExecutionRun['status']; started_at: string; finished_at: string | null; input_json: string; output_json: string | null; error_text: string | null; node_count: number; error_count: number };
type StepRow = { id: string; execution_id: string; sequence_no: number; node_id: string; node_name: string; node_type: string; status: ExecutionStep['status']; started_at: string; finished_at: string | null; input_json: string; output_json: string | null; outputs_json: string | null; parameters_json: string; error_text: string | null };
type EventRow = { id: string; execution_id: string; step_id: string | null; node_id: string | null; level: ExecutionEvent['level']; event_time: string; message: string; data_json: string | null };
type AutomationStatsRow = { workflow_id: string; execution_count: number; last_execution_at: string; last_execution_status: ExecutionRun['status']; avg_execution_ms: number | string | null };
type SqlClient = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>) & { begin<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>; close(): Promise<void> };

function sqlClient(pool: Pool, connection?: PoolConnection): SqlClient {
  const client = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.reduce((sql, part, index) => sql + part + (index < values.length ? '?' : ''), '');
    const executor = connection || pool;
    const [rows] = values.length ? await executor.execute(statement, values as any[]) : await executor.query(statement);
    return Array.isArray(rows) ? rows : [];
  }) as SqlClient;
  client.begin = async <T,>(work: (tx: SqlClient) => Promise<T>): Promise<T> => {
    if (connection) throw new Error('Nested database transactions are not supported');
    const txConnection = await pool.getConnection();
    try {
      await txConnection.beginTransaction();
      const result = await work(sqlClient(pool, txConnection));
      await txConnection.commit();
      return result;
    } catch (error) { await txConnection.rollback(); throw error; }
    finally { txConnection.release(); }
  };
  client.close = async () => { if (!connection) await pool.end(); };
  return client;
}

const encoded = (value: unknown) => JSON.stringify(value ?? null);
const decoded = (value: string | null) => value == null ? undefined : JSON.parse(value);
const runFromRow = (row: RunRow): ExecutionRun => ({ id: row.id, workflowId: row.workflow_id, workflowName: row.workflow_name, trigger: row.trigger_type, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at || undefined, input: decoded(row.input_json), output: decoded(row.output_json), error: row.error_text || undefined, nodeCount: Number(row.node_count), errorCount: Number(row.error_count) });
const stepFromRow = (row: StepRow): ExecutionStep => ({ id: row.id, executionId: row.execution_id, sequence: Number(row.sequence_no), nodeId: row.node_id, nodeName: row.node_name, nodeType: row.node_type, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at || undefined, input: decoded(row.input_json), output: decoded(row.output_json), outputs: decoded(row.outputs_json), parameters: decoded(row.parameters_json), error: row.error_text || undefined });
const eventFromRow = (row: EventRow): ExecutionEvent => ({ id: row.id, executionId: row.execution_id, stepId: row.step_id || undefined, nodeId: row.node_id || undefined, level: row.level, time: row.event_time, message: row.message, data: decoded(row.data_json) });

export class DatabaseStore implements ExecutionRecorder, EmailCursorStore {
  readonly sql: SqlClient;

  constructor() {
    const provider = process.env.DB_PROVIDER?.toLowerCase();
    if (provider !== 'mysql' && provider !== 'mariadb') throw new Error('DB_PROVIDER must be mysql or mariadb');
    for (const key of ['DB_HOST', 'DATABASE_NAME', 'DB_USER', 'DB_PASSWORD']) if (!process.env[key]) throw new Error(`${key} is missing from .env`);
    this.sql = sqlClient(createPool({ host: process.env.DB_HOST!, port: Number(process.env.DB_PORT || 3306), database: process.env.DATABASE_NAME!, user: process.env.DB_USER!, password: process.env.DB_PASSWORD!, connectionLimit: 10, waitForConnections: true, enableKeepAlive: true, dateStrings: true }));
  }

  async initialize(dataDir: string) {
    const db = this.sql;
    await db`SELECT 1`;
    await db`CREATE TABLE IF NOT EXISTS wflow_meta (meta_key VARCHAR(80) PRIMARY KEY, meta_value TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_workflows (id VARCHAR(64) PRIMARY KEY, name VARCHAR(80) NOT NULL, updated_at VARCHAR(32) NOT NULL, flow_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_deployments (workflow_id VARCHAR(64) PRIMARY KEY, snapshot_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_executions (id VARCHAR(64) PRIMARY KEY, workflow_id VARCHAR(64) NOT NULL, workflow_name VARCHAR(80) NOT NULL, trigger_type VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, started_at VARCHAR(32) NOT NULL, finished_at VARCHAR(32) NULL, input_json LONGTEXT NOT NULL, output_json LONGTEXT NULL, error_text TEXT NULL, node_count INT NOT NULL DEFAULT 0, error_count INT NOT NULL DEFAULT 0, INDEX ix_workflow_started (workflow_id, started_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_execution_steps (id VARCHAR(64) PRIMARY KEY, execution_id VARCHAR(64) NOT NULL, sequence_no INT NOT NULL, node_id VARCHAR(64) NOT NULL, node_name VARCHAR(255) NOT NULL, node_type VARCHAR(80) NOT NULL, status VARCHAR(20) NOT NULL, started_at VARCHAR(32) NOT NULL, finished_at VARCHAR(32) NULL, input_json LONGTEXT NOT NULL, output_json LONGTEXT NULL, outputs_json LONGTEXT NULL, parameters_json LONGTEXT NOT NULL, error_text TEXT NULL, INDEX ix_execution_sequence (execution_id, sequence_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_execution_events (id VARCHAR(64) PRIMARY KEY, execution_id VARCHAR(64) NOT NULL, step_id VARCHAR(64) NULL, node_id VARCHAR(64) NULL, level VARCHAR(12) NOT NULL, event_time VARCHAR(32) NOT NULL, message TEXT NOT NULL, data_json LONGTEXT NULL, INDEX ix_execution_time (execution_id, event_time)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_email_cursors (workflow_id VARCHAR(64) NOT NULL, node_id VARCHAR(64) NOT NULL, folder VARCHAR(255) NOT NULL, uid_validity VARCHAR(40) NOT NULL, last_uid BIGINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (workflow_id, node_id, folder)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await db`CREATE TABLE IF NOT EXISTS wflow_secrets (id VARCHAR(64) PRIMARY KEY, name VARCHAR(128) NOT NULL UNIQUE, description VARCHAR(500) NOT NULL DEFAULT '', created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, last_used_at VARCHAR(32) NULL, version INT NOT NULL DEFAULT 1, nonce VARBINARY(12) NOT NULL, ciphertext MEDIUMBLOB NOT NULL, auth_tag VARBINARY(16) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await this.migrateLegacy(dataDir);
  }

  private async migrateLegacy(dataDir: string) {
    const marker = await this.sql`SELECT meta_key FROM wflow_meta WHERE meta_key = ${'legacy_json_v1'}`;
    if (marker.length) return;
    const existing = new Set((await this.sql`SELECT id FROM wflow_workflows` as { id: string }[]).map(row => row.id));
    const existingDeployments = new Set((await this.sql`SELECT workflow_id FROM wflow_deployments` as { workflow_id: string }[]).map(row => row.workflow_id));
    let workflows: Workflow[] = [];
    let deployments: Workflow[] = [];
    try { workflows = JSON.parse(await readFile(join(dataDir, 'workflows.json'), 'utf8')); } catch { /* no legacy workflows */ }
    try { deployments = JSON.parse(await readFile(join(dataDir, 'deployed.json'), 'utf8')); } catch { /* no legacy deployments */ }
    for (const flow of workflows) if (!existing.has(flow.id)) await this.saveWorkflow(flow);
    for (const snapshot of deployments) if (!existingDeployments.has(snapshot.id) && (existing.has(snapshot.id) || workflows.some(flow => flow.id === snapshot.id))) await this.saveDeployment(snapshot);
    await this.sql`INSERT INTO wflow_meta (meta_key, meta_value) VALUES (${'legacy_json_v1'}, ${new Date().toISOString()})`;
  }

  async listWorkflows(): Promise<Workflow[]> {
    const rows = await this.sql`SELECT flow_json FROM wflow_workflows ORDER BY updated_at DESC` as JsonRow[];
    return rows.map(row => JSON.parse(row.flow_json!));
  }
  async listDeployments(): Promise<Workflow[]> {
    const rows = await this.sql`SELECT snapshot_json FROM wflow_deployments` as JsonRow[];
    return rows.map(row => JSON.parse(row.snapshot_json!));
  }
  async listAutomationStats() {
    const rows = await this.sql`SELECT run.workflow_id, COUNT(*) AS execution_count, MAX(run.started_at) AS last_execution_at,
      (SELECT latest.status FROM wflow_executions latest WHERE latest.workflow_id = run.workflow_id ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1) AS last_execution_status,
      AVG(CASE WHEN run.finished_at IS NOT NULL THEN TIMESTAMPDIFF(MICROSECOND,
        STR_TO_DATE(LEFT(run.started_at, 23), '%Y-%m-%dT%H:%i:%s.%f'),
        STR_TO_DATE(LEFT(run.finished_at, 23), '%Y-%m-%dT%H:%i:%s.%f')) / 1000 END) AS avg_execution_ms
      FROM wflow_executions run GROUP BY run.workflow_id` as AutomationStatsRow[];
    return new Map(rows.map(row => [row.workflow_id, {
      executionCount: Number(row.execution_count), lastExecutionAt: row.last_execution_at,
      lastExecutionStatus: row.last_execution_status,
      avgExecutionMs: row.avg_execution_ms == null ? undefined : Math.max(0, Number(row.avg_execution_ms)),
    }]));
  }
  async saveWorkflow(flow: Workflow) {
    await this.sql`INSERT INTO wflow_workflows (id, name, updated_at, flow_json) VALUES (${flow.id}, ${flow.name}, ${flow.updatedAt}, ${encoded(flow)}) ON DUPLICATE KEY UPDATE name = ${flow.name}, updated_at = ${flow.updatedAt}, flow_json = ${encoded(flow)}`;
  }
  async deleteWorkflow(id: string) {
    await this.sql.begin(async tx => {
      await tx`DELETE FROM wflow_deployments WHERE workflow_id = ${id}`;
      await tx`DELETE FROM wflow_workflows WHERE id = ${id}`;
    });
  }
  async saveDeployment(snapshot: Workflow) {
    await this.sql`INSERT INTO wflow_deployments (workflow_id, snapshot_json) VALUES (${snapshot.id}, ${encoded(snapshot)}) ON DUPLICATE KEY UPDATE snapshot_json = ${encoded(snapshot)}`;
  }
  async deleteDeployment(id: string) { await this.sql`DELETE FROM wflow_deployments WHERE workflow_id = ${id}`; }

  async startRun(run: ExecutionRun) {
    await this.sql`INSERT INTO wflow_executions (id, workflow_id, workflow_name, trigger_type, status, started_at, input_json, node_count, error_count) VALUES (${run.id}, ${run.workflowId}, ${run.workflowName}, ${run.trigger}, ${run.status}, ${run.startedAt}, ${encoded(run.input)}, ${run.nodeCount}, ${run.errorCount})`;
  }
  async finishRun(run: ExecutionRun) {
    await this.sql`UPDATE wflow_executions SET status = ${run.status}, finished_at = ${run.finishedAt || null}, output_json = ${encoded(run.output)}, error_text = ${run.error || null}, node_count = ${run.nodeCount}, error_count = ${run.errorCount} WHERE id = ${run.id}`;
  }
  async startStep(step: ExecutionStep) {
    await this.sql`INSERT INTO wflow_execution_steps (id, execution_id, sequence_no, node_id, node_name, node_type, status, started_at, input_json, parameters_json) VALUES (${step.id}, ${step.executionId}, ${step.sequence}, ${step.nodeId}, ${step.nodeName}, ${step.nodeType}, ${step.status}, ${step.startedAt}, ${encoded(step.input)}, ${encoded(step.parameters)})`;
  }
  async finishStep(step: ExecutionStep) {
    await this.sql`UPDATE wflow_execution_steps SET status = ${step.status}, finished_at = ${step.finishedAt || null}, output_json = ${encoded(step.output)}, outputs_json = ${encoded(step.outputs)}, error_text = ${step.error || null} WHERE id = ${step.id}`;
  }
  async recordEvent(event: ExecutionEvent) {
    await this.sql`INSERT INTO wflow_execution_events (id, execution_id, step_id, node_id, level, event_time, message, data_json) VALUES (${event.id}, ${event.executionId}, ${event.stepId || null}, ${event.nodeId || null}, ${event.level}, ${event.time}, ${event.message}, ${encoded(event.data)})`;
  }

  async getEmailCursor(workflowId: string, nodeId: string, folder: string) {
    const rows = await this.sql`SELECT uid_validity, last_uid FROM wflow_email_cursors WHERE workflow_id = ${workflowId} AND node_id = ${nodeId} AND folder = ${folder}` as { uid_validity: string; last_uid: number }[];
    return rows.length ? { uidValidity: rows[0].uid_validity, lastUid: Number(rows[0].last_uid) } : null;
  }
  async setEmailCursor(workflowId: string, nodeId: string, folder: string, uidValidity: string, lastUid: number) {
    await this.sql`INSERT INTO wflow_email_cursors (workflow_id, node_id, folder, uid_validity, last_uid) VALUES (${workflowId}, ${nodeId}, ${folder}, ${uidValidity}, ${lastUid}) ON DUPLICATE KEY UPDATE uid_validity = ${uidValidity}, last_uid = ${lastUid}`;
  }

  async listExecutions(workflowId: string, limit = 50, offset = 0): Promise<ExecutionRun[]> {
    const rows = await this.sql`SELECT * FROM wflow_executions WHERE workflow_id = ${workflowId} ORDER BY started_at DESC, id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)} OFFSET ${Math.max(offset, 0)}` as RunRow[];
    return rows.map(runFromRow);
  }
  async getExecution(id: string): Promise<ExecutionDetail | null> {
    const runs = await this.sql`SELECT * FROM wflow_executions WHERE id = ${id}` as RunRow[];
    if (!runs.length) return null;
    const [steps, events] = await Promise.all([
      this.sql`SELECT * FROM wflow_execution_steps WHERE execution_id = ${id} ORDER BY sequence_no ASC` as Promise<StepRow[]>,
      this.sql`SELECT * FROM wflow_execution_events WHERE execution_id = ${id} ORDER BY event_time ASC` as Promise<EventRow[]>,
    ]);
    return { run: runFromRow(runs[0]), steps: steps.map(stepFromRow), events: events.map(eventFromRow) };
  }
}
