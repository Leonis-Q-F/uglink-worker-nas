# UGLINK Control design system

This document defines the visual rules used by the runtime interface.

## Visual language

- Canvas: true white (`#ffffff`) with cool gray surfaces (`#f7f9fc`).
- Text: navy-black (`#0b1733`) for hierarchy and slate (`#64748b`) for supporting copy.
- Primary action: UGREEN-inspired orange (`#f47b20`), with darker hover and strong focus rings.
- Structural accent: deep navy (`#082b61`). Success uses `#16813c`; destructive actions use `#c7362f`.
- Borders: crisp one-pixel blue-gray rules (`#d8e0eb`). Shadows are reserved for menus and modal layers.
- Typography: Inter-compatible system sans stack, 14–16 px controls, compact tables, 32 px page headings.
- Icons: Lucide outline icons, generally 18–20 px with a 1.75 px stroke.
- Motion: 150–180 ms for hover, focus, disclosure, and progress transitions. Reduced-motion preferences disable nonessential transitions.

## Layout

- Product header: 72 px.
- Authenticated desktop: 224 px navigation rail, fluid editor, 380 px inspector.
- Connection screen: 320 px progress rail and a centered 760 px connection workspace.
- Under 1080 px the inspector moves below the editor. Under 760 px the side navigation becomes a horizontal section selector and tables become vertically stacked rows.

## Interaction states

- Every form field has visible labels, descriptions, keyboard focus, and inline validation.
- API Token connection forms show idle, validating, connected, and error states without exposing the credential.
- Deployment is explicit: validate first, then deploy directly to Cloudflare; the password is never persisted or displayed again.
- Destructive service removal requires a second click while the row is in a pending-removal state.
