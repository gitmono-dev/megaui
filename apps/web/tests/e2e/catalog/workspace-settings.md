# workspace-settings e2e catalog

> Specification: WA-17  
> Provenance: megaui lean settings (REF-01 settings; no SSH/PAT — WA-18; avatar URL only — WA-19)

## Purpose

Coverage for `/[lang]/workspace/settings` foundation sections: profile persist, invalid bio, password + sessions, appearance FOUC-safe theme persist.

## Scenarios

| ID | Name | AC |
|----|------|----|
| S-01 | Profile bio save → reload | AC-1 |
| S-02 | Invalid bio length i18n | AC-1 |
| S-02b | Notifications delivery save → reload | AC-1 |
| S-03 | Change password revokes other live session | AC-2 |
| S-04 | Appearance dark mode survives reload | AC-3 |

## Notes

- profile-prefs + user/notifications via WA-05 BFF; password/sessions via Better Auth client.
- SSH keys / PAT tokens out of scope (WA-18).
