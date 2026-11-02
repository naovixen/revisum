---
paths:
  - "packages/report/src/render/**"
---

# Report HTML and CSS

Revisum audits accessibility, so its own report must pass.

- Use the semantically correct element. Add ARIA only when an element can't convey it.
- Write lowercase elements and attributes. Never use `on*` attributes.
- Classes are kebab-case BEM: `block__element--modifier`.
- New CSS variables are `--set-type-name`: `--colour-text-primary`.
- Sizes are `rem`. `line-height` is unitless.
