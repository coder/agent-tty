# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

## Automation state labels

The `github-issue-triage` workflow also uses two automation-state labels that are separate from the canonical triage roles:

| Label            | Meaning                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage:ongoing` | Manual or external automation in-progress marker; the workflow defers issues carrying it and only removes it as successful publish cleanup. |
| `triage:done`    | Completion marker; publish mode applies it after posting a verified triage comment, and future reconciles skip it.                          |

Create these labels before running the workflow in a repository that does not already have them, for example:

```sh
gh label create 'triage:ongoing' --description 'Issue triage is in progress elsewhere'
gh label create 'triage:done' --description 'Issue triage draft has been reviewed'
```

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
