# workspace-settings-credentials e2e catalog

> Specification: WA-18  
> Provenance: megaui settings credentials (REF-01 settings credentials; REF-02 mega2 SSH/tokens)

## Purpose

Coverage for `/[lang]/workspace/settings?section=ssh-keys|tokens`: add/validate SSH keys, add/delete GPG keys, one-time PAT reveal, delete/revoke.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Valid SSH add + invalid type reject | AC-1 |
| S-02 | Token plaintext once then masked list | AC-2 |
| S-03 | Delete SSH key + revoke token | AC-3 |
| S-04 | List, add and delete GPG keys | AC-4 |
| S-05 | Chinese SSH and GPG cards match empty-state and hint typography, use neutral form toggles and primary submit buttons, and omit trailing periods while preserving the SSH `.pub` extension | AC-1, AC-4 |

## Notes

- BFF: `GET/POST /api/mega/user/ssh`, `DELETE /api/mega/user/ssh/:id`, `GET /api/mega/user/tokens`, `POST .../tokens/generate`, `DELETE .../tokens/:id`.
- GPG: `GET/POST /api/mega/user/gpg`, `DELETE /api/mega/user/gpg/:id`.
- Private key upload unsupported.
