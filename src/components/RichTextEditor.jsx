import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import FontFamily from '@tiptap/extension-font-family';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

const BLOCK_OPTIONS = [
  { label: '正文', value: 'paragraph' },
  { label: '标题 1', value: 'h1' },
  { label: '标题 2', value: 'h2' },
  { label: '标题 3', value: 'h3' },
  { label: '引用', value: 'blockquote' },
  { label: '代码块', value: 'codeBlock' },
];

const FONT_FAMILY_OPTIONS = [
  { label: '默认字体', value: '' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: '宋体', value: 'SimSun' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Times', value: 'Times New Roman' },
  { label: 'Courier', value: 'Courier New' },
  { label: 'Georgia', value: 'Georgia' },
];

const FONT_SIZE_OPTIONS = [
  { label: '12', value: '12px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '24', value: '24px' },
  { label: '32', value: '32px' },
];

const DEFAULT_TEXT_COLOR = '#1f2937';
const DEFAULT_HIGHLIGHT_COLOR = '#fff59d';
const DEFAULT_FONT_SIZE = '14px';

const clampHexColor = (value, fallback) => {
  if (!value) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(raw)) return raw.startsWith('#') ? raw : `#${raw}`;
  const rgb = raw.match(
    /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+\s*)?\)/
  );
  if (rgb) {
    const channels = rgb.slice(1, 4).map((part) => {
      const num = Number(part);
      return Number.isFinite(num) ? Math.max(0, Math.min(255, num)) : 0;
    });
    return `#${channels.map((item) => item.toString(16).padStart(2, '0')).join('')}`;
  }
  return fallback;
};

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
    };
  },
});

const Indent = Extension.create({
  name: 'indent',
  addOptions() {
    return { types: ['paragraph', 'heading'], min: 0, max: 7, step: 24 };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const raw = (element.style.marginLeft || '').trim().toLowerCase();
              const matched = raw.match(/(\d+(?:\.\d+)?)px/);
              if (!matched) return 0;
              const px = Number(matched[1]);
              if (!Number.isFinite(px)) return 0;
              const level = Math.round(px / this.options.step);
              return Math.max(this.options.min, Math.min(this.options.max, level));
            },
            renderHTML: (attributes) => {
              const level = Number(attributes.indent || 0);
              if (!level) return {};
              const safeLevel = Math.max(this.options.min, Math.min(this.options.max, level));
              return { style: `margin-left: ${safeLevel * this.options.step}px` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    const updateIndent = (state, dispatch, delta) => {
      let tr = state.tr;
      let changed = false;

      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (!this.options.types.includes(node.type.name)) return true;
        const current = Number(node.attrs.indent || 0);
        const next = Math.max(this.options.min, Math.min(this.options.max, current + delta));
        if (next === current) return false;
        tr = tr.setNodeMarkup(pos, node.type, { ...node.attrs, indent: next }, node.marks);
        changed = true;
        return false;
      });

      if (changed && dispatch) dispatch(tr);
      return changed;
    };

    return {
      indent:
        () =>
        ({ state, dispatch }) =>
          updateIndent(state, dispatch, 1),
      outdent:
        () =>
        ({ state, dispatch }) =>
          updateIndent(state, dispatch, -1),
    };
  },
});

function ToolButton({ label, title, onClick, disabled, active = false }) {
  return (
    <button
      type="button"
      className={`notion-rich-tool-btn${active ? ' is-active' : ''}`}
      title={title || label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="notion-rich-divider" aria-hidden="true" />;
}

const getBlockType = (editor) => {
  if (!editor) return 'paragraph';
  if (editor.isActive('heading', { level: 1 })) return 'h1';
  if (editor.isActive('heading', { level: 2 })) return 'h2';
  if (editor.isActive('heading', { level: 3 })) return 'h3';
  if (editor.isActive('blockquote')) return 'blockquote';
  if (editor.isActive('codeBlock')) return 'codeBlock';
  return 'paragraph';
};

export default function RichTextEditor({
  value = '',
  onChange,
  disabled = false,
  placeholder = '开始编辑...',
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [imageError, setImageError] = useState('');
  const imageInputRef = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TextStyle,
      FontSize,
      FontFamily.configure({ types: ['textStyle'] }),
      Color.configure({ types: ['textStyle'] }),
      Highlight.configure({ multicolor: true }),
      Underline,
      Subscript,
      Superscript,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Indent,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder,
      }),
    ],
    content: value || '<p></p>',
    editable: !disabled,
    onUpdate: ({ editor: currentEditor }) => {
      onChange?.(currentEditor.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'notion-rich-content notion-rich-content-prose',
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    const next = typeof value === 'string' && value.trim() ? value : '<p></p>';
    if (next !== editor.getHTML()) {
      editor.commands.setContent(next, false);
    }
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    if (!editor) return;
    const rerender = () => setRefreshKey((key) => key + 1);
    editor.on('selectionUpdate', rerender);
    editor.on('transaction', rerender);
    editor.on('focus', rerender);
    editor.on('blur', rerender);
    return () => {
      editor.off('selectionUpdate', rerender);
      editor.off('transaction', rerender);
      editor.off('focus', rerender);
      editor.off('blur', rerender);
    };
  }, [editor]);

  const state = useMemo(() => {
    if (!editor) {
      return {
        blockType: 'paragraph',
        fontFamily: '',
        fontSize: DEFAULT_FONT_SIZE,
        textColor: DEFAULT_TEXT_COLOR,
        highlightColor: DEFAULT_HIGHLIGHT_COLOR,
      };
    }

    const textStyleAttrs = editor.getAttributes('textStyle');
    const highlightAttrs = editor.getAttributes('highlight');

    return {
      blockType: getBlockType(editor),
      fontFamily: textStyleAttrs.fontFamily || '',
      fontSize: textStyleAttrs.fontSize || DEFAULT_FONT_SIZE,
      textColor: clampHexColor(textStyleAttrs.color, DEFAULT_TEXT_COLOR),
      highlightColor: clampHexColor(highlightAttrs.color, DEFAULT_HIGHLIGHT_COLOR),
    };
  }, [editor, refreshKey]);

  const run = (command) => {
    if (!editor || disabled) return;
    command(editor.chain().focus()).run();
  };

  const setBlockType = (nextBlockType) => {
    if (!editor || disabled) return;
    const chain = editor.chain().focus();
    if (nextBlockType === 'paragraph') {
      chain.setParagraph().run();
    } else if (nextBlockType === 'h1') {
      chain.setHeading({ level: 1 }).run();
    } else if (nextBlockType === 'h2') {
      chain.setHeading({ level: 2 }).run();
    } else if (nextBlockType === 'h3') {
      chain.setHeading({ level: 3 }).run();
    } else if (nextBlockType === 'blockquote') {
      chain.setBlockquote().run();
    } else if (nextBlockType === 'codeBlock') {
      chain.setCodeBlock().run();
    }
  };

  const handleSetLink = () => {
    if (!editor || disabled) return;
    const previousUrl = editor.getAttributes('link').href || 'https://';
    const url = window.prompt('输入链接地址', previousUrl);
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: url.trim() }).run();
  };

  const handleInsertImage = () => {
    if (!editor || disabled) return;
    setImageError('');
    imageInputRef.current?.click();
  };

  const handleImageFileChange = (event) => {
    if (!editor || disabled) return;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setImageError('请选择图片文件。');
      return;
    }

    const maxBytes = 8 * 1024 * 1024;
    if (file.size > maxBytes) {
      setImageError('图片过大，请选择 8MB 以内的图片。');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!src.startsWith('data:image/')) {
        setImageError('读取图片失败，请重试。');
        return;
      }
      const alt = file.name.replace(/\.[^/.]+$/, '');
      editor.chain().focus().setImage({ src, alt }).run();
      setImageError('');
    };
    reader.onerror = () => {
      setImageError('读取图片失败，请重试。');
    };
    reader.readAsDataURL(file);
  };

  const handleIndent = () => {
    if (!editor || disabled) return;
    if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
      editor.chain().focus().sinkListItem('listItem').run();
      return;
    }
    editor.chain().focus().indent().run();
  };

  const handleOutdent = () => {
    if (!editor || disabled) return;
    if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
      editor.chain().focus().liftListItem('listItem').run();
      return;
    }
    editor.chain().focus().outdent().run();
  };

  const toolbarDisabled = !editor || disabled;
  const inTable = !!editor?.isActive('table');

  return (
    <div className={`notion-rich-editor${disabled ? ' is-disabled' : ''}`}>
      <div className="notion-rich-toolbar" role="toolbar" aria-label="文档样式工具栏">
        <div className="notion-rich-toolbar-row">
          <div className="notion-rich-group">
            <ToolButton
              label="↶"
              title="撤销 (Ctrl/Cmd+Z)"
              onClick={() => run((chain) => chain.undo())}
              disabled={toolbarDisabled || !editor?.can().chain().focus().undo().run()}
            />
            <ToolButton
              label="↷"
              title="重做 (Ctrl/Cmd+Shift+Z)"
              onClick={() => run((chain) => chain.redo())}
              disabled={toolbarDisabled || !editor?.can().chain().focus().redo().run()}
            />
            <ToolButton
              label="清除格式"
              title="清除样式"
              onClick={() => run((chain) => chain.clearNodes().unsetAllMarks())}
              disabled={toolbarDisabled}
            />
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <select
              className="notion-rich-select notion-rich-select-block"
              aria-label="段落样式"
              value={state.blockType}
              onChange={(event) => setBlockType(event.target.value)}
              disabled={toolbarDisabled}
            >
              {BLOCK_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            <select
              className="notion-rich-select notion-rich-select-font"
              aria-label="字体"
              value={state.fontFamily}
              onChange={(event) => {
                const family = event.target.value;
                if (!family) {
                  run((chain) => chain.unsetFontFamily());
                  return;
                }
                run((chain) => chain.setFontFamily(family));
              }}
              disabled={toolbarDisabled}
            >
              {FONT_FAMILY_OPTIONS.map((item) => (
                <option key={item.label} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>

            <select
              className="notion-rich-select notion-rich-select-size"
              aria-label="字号"
              value={state.fontSize}
              onChange={(event) => run((chain) => chain.setFontSize(event.target.value))}
              disabled={toolbarDisabled}
            >
              {FONT_SIZE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <ToolButton
              label="B"
              title="加粗 (Ctrl/Cmd+B)"
              onClick={() => run((chain) => chain.toggleBold())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('bold')}
            />
            <ToolButton
              label="I"
              title="斜体 (Ctrl/Cmd+I)"
              onClick={() => run((chain) => chain.toggleItalic())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('italic')}
            />
            <ToolButton
              label="U"
              title="下划线 (Ctrl/Cmd+U)"
              onClick={() => run((chain) => chain.toggleUnderline())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('underline')}
            />
            <ToolButton
              label="S"
              title="删除线"
              onClick={() => run((chain) => chain.toggleStrike())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('strike')}
            />
            <ToolButton
              label="Sub"
              title="下标"
              onClick={() => run((chain) => chain.toggleSubscript())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('subscript')}
            />
            <ToolButton
              label="Sup"
              title="上标"
              onClick={() => run((chain) => chain.toggleSuperscript())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('superscript')}
            />
          </div>
        </div>

        <div className="notion-rich-toolbar-row">
          <div className="notion-rich-group">
            <label className="notion-rich-color" title="文字颜色">
              字色
              <input
                type="color"
                value={state.textColor}
                onChange={(event) => run((chain) => chain.setColor(event.target.value))}
                disabled={toolbarDisabled}
              />
            </label>
            <label className="notion-rich-color" title="高亮颜色">
              高亮
              <input
                type="color"
                value={state.highlightColor}
                onChange={(event) =>
                  run((chain) => chain.toggleHighlight({ color: event.target.value }))
                }
                disabled={toolbarDisabled}
              />
            </label>
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <ToolButton
              label="左"
              title="左对齐"
              onClick={() => run((chain) => chain.setTextAlign('left'))}
              disabled={toolbarDisabled}
              active={!!editor?.isActive({ textAlign: 'left' })}
            />
            <ToolButton
              label="中"
              title="居中"
              onClick={() => run((chain) => chain.setTextAlign('center'))}
              disabled={toolbarDisabled}
              active={!!editor?.isActive({ textAlign: 'center' })}
            />
            <ToolButton
              label="右"
              title="右对齐"
              onClick={() => run((chain) => chain.setTextAlign('right'))}
              disabled={toolbarDisabled}
              active={!!editor?.isActive({ textAlign: 'right' })}
            />
            <ToolButton
              label="两端"
              title="两端对齐"
              onClick={() => run((chain) => chain.setTextAlign('justify'))}
              disabled={toolbarDisabled}
              active={!!editor?.isActive({ textAlign: 'justify' })}
            />
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <ToolButton
              label="• 列表"
              title="无序列表"
              onClick={() => run((chain) => chain.toggleBulletList())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('bulletList')}
            />
            <ToolButton
              label="1. 列表"
              title="有序列表"
              onClick={() => run((chain) => chain.toggleOrderedList())}
              disabled={toolbarDisabled}
              active={!!editor?.isActive('orderedList')}
            />
            <ToolButton label="← 缩进" title="减少缩进" onClick={handleOutdent} disabled={toolbarDisabled} />
            <ToolButton label="→ 缩进" title="增加缩进" onClick={handleIndent} disabled={toolbarDisabled} />
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <ToolButton label="链接" title="插入链接" onClick={handleSetLink} disabled={toolbarDisabled} />
            <ToolButton
              label="取消链接"
              title="移除链接"
              onClick={() => run((chain) => chain.unsetLink())}
              disabled={toolbarDisabled}
            />
            <ToolButton label="图片" title="插入本地图片" onClick={handleInsertImage} disabled={toolbarDisabled} />
            <ToolButton
              label="分隔线"
              title="插入分隔线"
              onClick={() => run((chain) => chain.setHorizontalRule())}
              disabled={toolbarDisabled}
            />
          </div>

          <ToolbarDivider />

          <div className="notion-rich-group">
            <ToolButton
              label="表格"
              title="插入 3x3 表格"
              onClick={() => run((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
              disabled={toolbarDisabled}
              active={inTable}
            />
            <ToolButton label="+行" title="在下方新增行" onClick={() => run((chain) => chain.addRowAfter())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="-行" title="删除当前行" onClick={() => run((chain) => chain.deleteRow())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="+列" title="在右侧新增列" onClick={() => run((chain) => chain.addColumnAfter())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="-列" title="删除当前列" onClick={() => run((chain) => chain.deleteColumn())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="合并" title="合并单元格" onClick={() => run((chain) => chain.mergeCells())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="拆分" title="拆分单元格" onClick={() => run((chain) => chain.splitCell())} disabled={toolbarDisabled || !inTable} />
            <ToolButton label="删表" title="删除表格" onClick={() => run((chain) => chain.deleteTable())} disabled={toolbarDisabled || !inTable} />
          </div>
        </div>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={handleImageFileChange}
        disabled={toolbarDisabled}
      />
      {imageError && (
        <p className="notion-doc-editor-error notion-rich-editor-msg" role="alert">
          {imageError}
        </p>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
