import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, placeholder as placeholderExt } from '@codemirror/view';
import { sql, PostgreSQL, MySQL, MSSQL, SQLite } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

const languageCompartment = new Compartment();

const lightTheme = EditorView.theme(
  {
    '&': {
      fontSize: '12.8px',
      fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      backgroundColor: 'transparent',
      color: '#1f2430',
      borderRadius: '10px'
    },
    '.cm-content': { caretColor: '#4d6ae0', padding: '10px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#4d6ae0', borderLeftWidth: '2px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#b6b4c4',
      border: 'none',
      paddingRight: '4px'
    },
    // The selection layer is painted behind the text, so the active-line tint must stay translucent
    // or it hides a selection that sits on the cursor line.
    '.cm-activeLine': { backgroundColor: 'rgba(77, 106, 224, 0.07)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#4d6ae0' },
    '.cm-selectionBackground': { backgroundColor: '#dbe2fb' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: '#b4c3f8' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(77, 106, 224, 0.16)' },
    '.cm-line': { padding: '0 12px' },
    '.cm-tooltip': {
      border: '1px solid #e7e6ee',
      borderRadius: '10px',
      backgroundColor: '#ffffff',
      boxShadow: '0 8px 24px rgba(17,24,39,.12)',
      overflow: 'hidden'
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#eef1fc', color: '#2b3a8c' },
    '.cm-tooltip-autocomplete ul li': { padding: '3px 10px', fontFamily: '"Geist Mono Variable", monospace', fontSize: '12px' },
    '.cm-panels': { backgroundColor: '#ffffff', color: '#1f2430' }
  },
  { dark: false }
);

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#3a55c9', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: '#16794a' },
  { tag: [tags.number, tags.bool, tags.null], color: '#b45309' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#9aa0ae', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: '#5b6474' },
  { tag: [tags.variableName, tags.propertyName], color: '#1f2430' },
  { tag: [tags.typeName, tags.className], color: '#0e7490' },
  { tag: tags.function(tags.variableName), color: '#5b74e8' },
  { tag: tags.invalid, color: '#b3261e' }
]);

export function dialectFor(engine: string) {
  switch (engine) {
    case 'postgres':
      return PostgreSQL;
    case 'mysql':
      return MySQL;
    case 'mssql':
      return MSSQL;
    case 'sqlite':
      return SQLite;
    default:
      return PostgreSQL;
  }
}

function sqlLanguage(engine: string, schema: Record<string, string[]> | null | undefined) {
  return sql({
    dialect: dialectFor(engine),
    schema: schema ?? undefined,
    upperCaseKeywords: true
  });
}

export interface SqlEditorOptions {
  value: string;
  engine?: string;
  schema?: Record<string, string[]> | null;
  readOnly?: boolean;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
  onRun?: () => void;
}

export function selectedSql(view: EditorView): string {
  const range = view.state.selection.main;
  return range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to);
}

export function hasSelection(view: EditorView): boolean {
  return !view.state.selection.main.empty;
}

export function mountSqlEditor(container: HTMLElement, options: SqlEditorOptions): EditorView {
  const extensions = [
    basicSetup,
    languageCompartment.of(sqlLanguage(options.engine ?? 'postgres', options.schema)),
    lightTheme,
    syntaxHighlighting(lightHighlight),
    EditorView.lineWrapping,
    EditorState.readOnly.of(Boolean(options.readOnly)),
    EditorView.editable.of(!options.readOnly),
    EditorView.theme({
      '.cm-scroller': {
        maxHeight: options.maxHeight ?? '340px',
        minHeight: options.minHeight ?? '120px',
        overflow: 'auto'
      }
    })
  ];

  if (options.placeholder) {
    extensions.push(placeholderExt(options.placeholder));
  }
  if (options.onChange || options.onSelectionChange) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (options.onChange && update.docChanged) options.onChange(update.state.doc.toString());
        if (options.onSelectionChange && update.selectionSet) options.onSelectionChange(!update.state.selection.main.empty);
      })
    );
  }
  if (options.onRun) {
    extensions.push(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            options.onRun?.();
            return true;
          }
          return false;
        }
      })
    );
  }

  return new EditorView({
    state: EditorState.create({ doc: options.value, extensions }),
    parent: container
  });
}

export function refreshEditorLanguage(view: EditorView, engine: string, schema: Record<string, string[]> | null): void {
  view.dispatch({
    effects: languageCompartment.reconfigure(sqlLanguage(engine, schema))
  });
}
