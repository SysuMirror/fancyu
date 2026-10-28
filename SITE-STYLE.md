# Shared campus style

Applied the approved homepage palette to all 20 remaining HTML pages: authentication, account settings, questionnaires, matching, buddy cards, administration, terms and maintenance.

Shared `web/campus-ui.css` provides ivory backgrounds, pale sage cards, deep green text, outlined controls, readable dropdowns, focus indicators and mobile layouts. Selected states, disabled controls and destructive actions remain distinct. Page scripts and homepage assets are unchanged.

Validation: 40 browser page checks (390px with dark OS preference, 1280px with light OS preference), no navigation mismatches, horizontal document overflow or script errors. Mock-backed interaction checks cover grade dropdown color, selected choice, questionnaire navigation, buddy sheet and Escape, editable account modal, and disabled publication pending approval. Existing inline scripts compare byte-for-byte and pass syntax parsing. No production user data is modified by these checks.

Deployment checks compare HTTP-served bytes for all 21 assets and check API health. Original files are backed up before deployment; failed checks restore the originals.
