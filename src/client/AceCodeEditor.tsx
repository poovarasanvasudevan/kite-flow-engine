import AceEditor from 'react-ace';
import 'ace-builds/src-noconflict/mode-javascript';
import 'ace-builds/src-noconflict/mode-json';
import 'ace-builds/src-noconflict/theme-github';
import type { CodeEditorProps } from './CodeEditor';

export default function AceCodeEditor({ name, mode, value, onChange, height = 170, readOnly = false }: CodeEditorProps) {
  return <div className="ace-shell">
    <AceEditor
      name={name}
      mode={mode}
      theme="github"
      value={value}
      onChange={onChange}
      width="100%"
      height={typeof height === 'number' ? `${height}px` : height}
      fontSize={11}
      readOnly={readOnly}
      showPrintMargin={false}
      highlightActiveLine={!readOnly}
      editorProps={{ $blockScrolling: true }}
      setOptions={{ useWorker: false, tabSize: 2, useSoftTabs: true, showLineNumbers: true }}
    />
  </div>;
}
