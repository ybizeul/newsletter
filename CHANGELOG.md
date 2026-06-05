# Changelog

All notable changes are documented from git tags and commit messages.

## v1.3 - 2026-06-05

Changes since v1.2:
- Added shareable public newsletter links with stable slugs and routing, making it easier to open published content directly.
- Improved public-link behavior in local development so preview and shared URLs resolve more reliably.
- Improved newsletter readability and visual consistency with better line-height, preserved text-transform styles, and more consistent typography.
- Improved newsletter editing reliability by ensuring footer markdown/HTML changes are correctly included in preview updates.
- Added a toggle to show unused articles with a clear visual indicator, helping editors spot reusable content faster.

## v1.2 - 2026-06-03

Changes since v1.1:
- Streamlined newsletter option pickers for language, header, and template selection with a clearer, more consistent chooser experience.
- Added persistent article search menu preferences so your browsing setup is remembered between sessions.

## v1.1 - 2026-06-03

Changes since v1.0.1:
- Added full multi-language workflow for articles and newsletters, including translation management and better fallback behavior.
- Introduced newsletter templates and improved option pickers for language, header, and template selection.
- Improved autosave reliability and stale-edit protection to reduce the risk of losing in-progress edits.
- Enhanced article language visibility and selection, including better mobile behavior for language switching.
- Improved editor writing experience with autocorrect/spellcheck support and clearer newsletter typography.
- Added quality-of-life improvements in article browsing, including saved preferences and easier access to unused content.

## v1.0.1 - 2026-06-02

Changes since v1.0.0:
- Fixed table width inconsistencies between the editor and newsletter preview.
- Simplified newsletter creation flow by removing an extra modal step and related validation friction.

## v1.0.0 - 2026-05-19

Changes since v0.9.0:
- Launched the first stable platform release with complete workflows for articles, headers, contacts, and newsletters.
- Added rich newsletter composition features: intro/footer editing, header support, optional index generation, content width controls, preview improvements, and better email HTML compatibility.
- Introduced autosave for articles and newsletters with stronger pending-edit handling to reduce data loss and race-condition issues.
- Improved article discovery and organization with smart filters, tags, usage indicators, ownership/visibility handling, duplication, and favorites.
- Expanded media and editor capabilities with enhanced TipTap editing, better image/SVG handling, topic icon customization, and improved mobile editing UX.
- Added sending and delivery enhancements, including immediate send flow, pending send handling, BCC support, and better sender/runtime configuration checks.
- Implemented authentication and security foundations with OIDC session management, OAuth2/XOAUTH2 improvements, token-expiration handling, and security hardening passes.
- Improved app usability and polish through responsive/mobile refinements, dark mode support, loading-state consistency, PWA support, and Safari navigation fixes.

## v0.9.0 - 2026-04-01

Initial tagged release.


