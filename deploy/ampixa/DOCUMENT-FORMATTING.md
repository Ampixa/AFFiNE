# Equations, highlights, and MCP tables

## Scientific writing

AFFiNE already includes an editable LaTeX/KaTeX equation editor; no external
rendering service is needed. Type `/equation` for a display equation, or search
`/scientific`, `/superscript`, or `/subscript` for an inline equation. Selecting
text and choosing **Inline Equation** in the formatting toolbar also works.

Examples to enter in the equation editor:

- `E = mc^2`
- `H_2O`
- `1.2 \times 10^{-3}`
- `\frac{a}{b}`

Equations are saved in the document and rendered for readers. This is LaTeX
formatting, not a symbolic calculator. MCP Markdown math conversion is not
added by this change; use the document editor for equations.

## Shared highlights

Select text, open **Highlight** in the formatting toolbar, and choose a color
under **Text highlight**. Choose **default background** to remove it. This
changes the document's saved rich text; it is not a temporary browser selection.
Readers see the highlight, while only users with editing permission can change
it. **Text color** changes foreground color separately.

## MCP tables

Ask the assistant to create or update a document with a Markdown pipe table:

```markdown
| Measurement   | Value            |
| ------------- | ---------------- |
| Temperature   | 298 K            |
| Concentration | 1.2 × 10⁻³ mol/L |
```

Use a header and separator row. These are simple editable tables, not database
or Kanban views. The server converts the native Markdown writer's legacy string
cells to collaborative text and repairs numeric ordering keys. New documents
and Markdown updates use this conversion; existing documents are not migrated
in bulk. Existing collaborative text cells are left intact by the repair.

The underlying Markdown parser retains inline formatting markers in table cells
as literal text; use the editor's formatting controls to style cell text.

## Release acceptance

1. Create an MCP document containing the example table. Open it, edit a cell,
   and insert a row and column. Reload and confirm that all changes remain.
2. Add inline `1.2 \times 10^{-3}` and a display equation. Reopen the document
   with read-only access and check that both render.
3. Highlight a sentence, reload, and view it from a reader account. Confirm
   the highlight remains and that the reader cannot change it.
4. Update surrounding text through MCP without changing the table. Confirm
   existing table content and highlights are preserved.
