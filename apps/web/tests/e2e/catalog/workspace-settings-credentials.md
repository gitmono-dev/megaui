# workspace-settings-credentials e2e catalog

> Specification: WA-18  
> Provenance: megaui settings credentials (REF-01 settings credentials; REF-02 mega2 SSH/tokens)

## Purpose

Coverage for `/[lang]/workspace/settings?section=ssh-keys|tokens`: add/validate SSH keys, one-time PAT reveal, delete/revoke.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Valid SSH add + invalid type reject | AC-1 |
| S-02 | Token plaintext once then masked list | AC-2 |
| S-03 | Delete SSH key + revoke token | AC-3 |

## Notes

- BFF: `GET/POST /api/mega/user/ssh`, `DELETE /api/mega/user/ssh/:id`, `GET /api/mega/user/tokens`, `POST .../tokens/generate`, `DELETE .../tokens/:id`.
- Private key upload unsupported.
