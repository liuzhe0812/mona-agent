import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { loadLanguage } from "@/lib/codemirror/languageLoader";

const lightTheme = EditorView.theme({
  "&": {
    backgroundColor: "#ffffff",
    color: "#1e1e1e",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
    caretColor: "#1e1e1e",
    lineHeight: "1.5",
  },
  ".cm-cursor": {
    borderLeftColor: "#1e1e1e",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#add6ff !important",
  },
  ".cm-activeLine": {
    backgroundColor: "#f3f3f3",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#f3f3f3",
  },
  ".cm-gutters": {
    backgroundColor: "#fafafa",
    borderRight: "1px solid #e0e0e0",
    color: "#6e7681",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "3em",
    paddingRight: "8px",
    textAlign: "right",
  },
  ".cm-matchingBracket": {
    backgroundColor: "#b4d5fe",
    textDecoration: "none",
  },
}, { dark: false });

interface IdeEditorProps {
  content: string;
  language: string | null;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}

export function IdeEditor({ content, language, onChange, onSave, readOnly }: IdeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef<Compartment | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const languageCompartment = new Compartment();
    languageCompartmentRef.current = languageCompartment;

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      lightTheme,
      languageCompartment.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString());
        }
      }),
      EditorView.editable.of(!readOnly),
    ];

    if (onSave) {
      extensions.push(
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSave();
              return true;
            },
          },
        ]),
      );
    }

    const startState = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });
    viewRef.current = view;

    if (language) {
      loadLanguage(language).then((langExt) => {
        if (langExt && viewRef.current && languageCompartmentRef.current) {
          viewRef.current.dispatch({
            effects: languageCompartmentRef.current.reconfigure(langExt),
          });
        }
      });
    }

    return () => {
      view.destroy();
      viewRef.current = null;
      languageCompartmentRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !language || !languageCompartmentRef.current) return;
    loadLanguage(language).then((langExt) => {
      if (!langExt || !viewRef.current || !languageCompartmentRef.current) return;
      viewRef.current.dispatch({
        effects: languageCompartmentRef.current.reconfigure(langExt),
      });
    });
  }, [language]);

  return <div ref={containerRef} className="h-full w-full overflow-auto" />;
}
