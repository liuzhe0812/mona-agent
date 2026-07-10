import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface WikiLinkOptions {
  HTMLAttributes: Record<string, string>;
  /** Called when the user clicks a resolved wiki link. */
  onOpenNote?: (title: string) => void;
}

export interface WikiLinkAttributes {
  title?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    wikiLink: {
      /**
       * Insert a wiki link node at the current cursor position.
       */
      insertWikiLink: (options?: WikiLinkAttributes) => ReturnType;
    };
  }
}

const NODE_NAME = "wikiLink";

const wikiLinkActivePluginKey = new PluginKey("wikiLinkActive");

function createWikiLinkDecorations(doc: any, selection: any): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "wikiLink") return;
    const from = pos;
    const to = pos + node.nodeSize;
    const inside = selection.from >= from && selection.to <= to;
    const cursorAtBoundary =
      selection.empty && (selection.from === from || selection.from === to);
    const attrs: Record<string, string> = {};
    if (inside) attrs["data-active"] = "";
    if (cursorAtBoundary) attrs["data-cursor-boundary"] = "";
    if (Object.keys(attrs).length > 0) {
      decorations.push(Decoration.node(from, to, attrs));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: NODE_NAME,

  inline: true,
  group: "inline",
  content: "",
  selectable: true,
  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      onOpenNote: undefined,
    };
  },

  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-title") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.title) return {};
          return { "data-title": attributes.title };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-wiki-link]",
      getAttrs: (el: HTMLElement) => ({
          title: el.getAttribute("data-title") ?? el.textContent ?? "",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = (node.attrs.title as string) || "";
    return [
      "span",
      mergeAttributes(
        {
          "data-wiki-link": "",
          "data-title": title,
          class: "wiki-link",
        },
        HTMLAttributes,
      ),
      title,
    ];
  },

  renderText({ node }) {
    const title = node.attrs.title || "";
    return `[[${title}]]`;
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode(NODE_NAME, {
      title: token.content || "",
    });
  },

  renderMarkdown(node: any) {
    const title = (node.attrs && node.attrs.title) || "";
    return `[[${title}]]`;
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start(src) {
      return src.indexOf("[[");
    },
    tokenize(src) {
      const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
      if (!match) return undefined;
      return {
        type: "wikiLink",
        raw: match[0],
        content: match[1],
        attributes: { title: match[1] },
      };
    },
  },

  addCommands() {
    return {
      insertWikiLink:
        (options = {}) =>
        ({ chain }) => {
          const title = options.title ?? "";
          return chain()
            .insertContent({
              type: this.name,
              attrs: { title },
              content: title ? [{ type: "text", text: title }] : [],
            })
            .focus()
            .run();
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("wikiLinkCollapse"),
        appendTransaction(_trs, _oldState, newState) {
          // Collapse `[[title]]` plain text back into a wikiLink node when the
          // cursor is no longer adjacent to it (Obsidian behaviour).
          const { selection, doc, schema } = newState;
          const wikiType = schema.nodes[NODE_NAME];
          if (!wikiType) return null;

          let matchFrom = -1;
          let matchTo = -1;
          let matchTitle = "";

          doc.descendants((node, pos) => {
            if (matchFrom >= 0 || !node.isText) return;
            const text = node.text || "";
            const m = /\[\[([^\]\n]+)\]\]/.exec(text);
            if (!m) return;
            const matchStart = pos + m.index;
            const matchEnd = matchStart + m[0].length;
            // Don't collapse if the cursor is inside or immediately adjacent to
            // the `[[...]]` text — the user may still be editing it.
            if (
              selection.from >= matchStart - 1 &&
              selection.from <= matchEnd + 1
            ) {
              return;
            }
            matchFrom = matchStart;
            matchTo = matchEnd;
            matchTitle = m[1];
          });

          if (matchFrom < 0) return null;
          const tr = newState.tr;
          tr.replaceWith(
            matchFrom,
            matchTo,
            wikiType.create({ title: matchTitle }),
          );
          return tr;
        },
      }),
      new Plugin({
        key: wikiLinkActivePluginKey,
        state: {
          init(_, { doc, selection }) {
            return createWikiLinkDecorations(doc, selection);
          },
          apply(tr, value) {
            if (!tr.docChanged && !tr.selectionSet) return value.map(tr.mapping, tr.doc);
            return createWikiLinkDecorations(tr.doc, tr.selection);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClickOn(view, _pos, node, nodePos, event, direct) {
            if (!direct || node.type.name !== NODE_NAME) return false;
            const end = nodePos + node.nodeSize;
            const title = (node.attrs.title as string) || "";
            // Obsidian behaviour: clicking the rightmost ~8px of the link enters
            // edit mode, anywhere else navigates to the target note.
            const target = event.target as HTMLElement | null;
            const rect = target?.getBoundingClientRect();
            const clickAtRightEdge =
              rect && event.clientX >= rect.right - 8 && event.clientX <= rect.right + 4;
            if (clickAtRightEdge) {
              event.preventDefault();
              const text = `[[${title}]]`;
              const tr = view.state.tr;
              tr.replaceWith(nodePos, end, view.state.schema.text(text));
              tr.setSelection(TextSelection.create(tr.doc, nodePos + text.length));
              view.dispatch(tr);
              return true;
            }
            event.preventDefault();
            if (title) options.onOpenNote?.(title);
            return true;
          },
        },
      }),
    ];
  },
});
