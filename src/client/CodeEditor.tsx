import { lazy, Suspense } from 'react';

export type CodeEditorProps = {
  name: string;
  mode: 'javascript' | 'json';
  value: string;
  onChange?: (value: string) => void;
  height?: number | string;
  readOnly?: boolean;
};

const AceCodeEditor = lazy(() => import('./AceCodeEditor'));

export function CodeEditor(props: CodeEditorProps) {
  return <Suspense fallback={<div className="ace-fallback">Loading editor…</div>}><AceCodeEditor {...props}/></Suspense>;
}
