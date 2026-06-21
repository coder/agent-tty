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

The `github-issue-triage` workflow also uses automation-state and risk labels that are separate from the canonical triage roles:

| Label            | Meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `triage:ongoing` | Manual or external automation in-progress marker; the workflow defers issues carrying it and does not remove it.               |
| `triage:done`    | Completion marker; deterministic publishing may apply it after posting and verifying a triage comment marker and final labels. |
| `triage:stopped` | Automation stopped before investigation or publication because the prompt-injection classifier found medium/high risk.         |
| `risk:medium`    | Classifier found ambiguous automation-directed content; maintainer review is required before publication.                      |
| `risk:high`      | Classifier found explicit or strong prompt-injection/social-engineering content; maintainer review is required.                |

Create these labels before running the workflow in a repository that does not already have them, for example:

```sh
gh label create 'triage:ongoing' --description 'Issue triage is in progress elsewhere'
gh label create 'triage:done' --description 'Issue triage draft has been reviewed'
gh label create 'triage:stopped' --description 'Issue triage automation stopped for maintainer review'
gh label create 'risk:medium' --description 'Potential prompt-injection risk needs maintainer review'
gh label create 'risk:high' --description 'High prompt-injection risk needs maintainer review'
```

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
