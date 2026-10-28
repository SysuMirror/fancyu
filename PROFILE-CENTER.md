# Personal center redesign

The account page now groups identity and verification, three participation cards, and account/security settings. Each card reads its existing matching API and links to the appropriate questionnaire, enrollment, progress or results page. Independent loading and retry states prevent API errors from appearing as nonparticipation. Weekly enrollment and automatic deep/buddy participation retain their existing rules.

Removed the duplicate legacy results section and the global friendship switch. Pair details and participation controls remain on their respective matching pages. Account nickname, password and password-confirmed deletion retain their API contracts. The page adds logout, masked email display, labeled inputs and modal Escape/focus handling.

Validation: browser checks at 390, 768 and 1280 pixels, including dark OS preference; no horizontal overflow or script errors. Mock-backed checks cover new users, completed questionnaires, enrollment, available results, independent API failure/retry, account nickname/password requests, modal dismissal/focus, and logout. All destination links exist. Screenshots were visually reviewed. No production account mutations were used for testing.

Static deployment backs up changed files and validates HTTP-served asset bytes plus service health. No backend code, database migration or service restart is required.
