# Documentation policy and style guide

## Purpose

This guide defines the documentation that belongs in this repository. It also defines the minimum quality requirements for new or changed content.

The repository documentation has two audiences:

- Users who deploy, configure, secure, or troubleshoot an MCP server.
- Developers who build, test, review, or contribute to an MCP server.

## Repository scope

Include content that helps a user or developer complete a current task. Examples include:

- installation and deployment procedures;
- configuration references;
- security requirements;
- test procedures and expected results;
- troubleshooting information;
- contribution and release procedures.

Do not include these content types:

- architecture decision records;
- internal proposals or roadmaps;
- handover notes or backup copies;
- point-in-time scan reports;
- copies of CI/CD runs, code-scanning, dependency, package, or attestation data;
- deployment-platform instructions that belong to a consumer or external integration harness.

Manage decisions and project planning in the approved external system. Use the git server, CI/CD system, and package registry for live evidence.

## Information design

Apply these information types as described by ISO/IEC/IEEE 26514:

- **Concept:** Explain what a component does and when to use it.
- **Procedure:** Give ordered steps that complete one task.
- **Reference:** Define settings, interfaces, inputs, outputs, or limits.
- **Troubleshooting:** Start with an observable symptom and give a corrective action.

Do not mix unrelated information types in one section. Put the information close to the task that needs it.

For each procedure:

1. State the result of the procedure.
2. List prerequisites before the steps.
3. Give one action in each numbered step.
4. Put commands immediately after the step that introduces them.
5. State the expected result when success is not obvious.
6. State destructive effects before the destructive command.
7. Provide a recovery or cleanup step when it is necessary.

## Language

Use plain language principles from ISO 24495-1. A reader must be able to find, understand, and use the information.

Apply relevant ASD-STE100 principles:

- Use short, direct sentences.
- Use active voice when the actor is known.
- Use one term for one concept.
- Use one instruction in each step.
- Put conditions before actions.
- Avoid unnecessary words, idioms, and marketing language.
- Define an abbreviation at its first use.
- Use approved technical names consistently.

These rules apply selected ASD-STE100 principles. They do not constitute a claim of formal ASD-STE100 conformity.

## Safety and usability

Apply IEC/IEEE 82079-1 principles to information for safe and effective use:

- Identify the intended audience and use case.
- Put warnings before the action that can cause harm or data loss.
- Distinguish development settings from shared or production settings.
- Do not hide prerequisites in examples.
- Make commands safe to copy when practical.
- Show how to verify the result.

Use `Warning` for a risk to security, credentials, availability, or data. Use `Important` for a condition that can cause the procedure to fail.

## Review requirements

Review documentation with the related code change. Apply the review and testing intent of ISO/IEC/IEEE 26513.

A reviewer must verify that:

- commands and file paths are current;
- examples do not contain credentials;
- required environment variables are complete;
- documented defaults match the code;
- links resolve;
- procedures have a clear success condition;
- security limitations are explicit;
- removed features have no remaining references.

Run the documented procedure when the change affects installation, configuration, deployment, or testing.

## Standards references

This repository applies relevant principles from these standards:

- [ASD-STE100, Simplified Technical English, Issue 9](https://www.asd-ste100.org/).
- [IEC/IEEE 82079-1:2019, preparation of information for use](https://webstore.iec.ch/en/publication/29075).
- [ISO/IEC/IEEE 26514:2022, design and development of information for software users](https://www.iso.org/standard/77451.html).
- [ISO/IEC/IEEE 26513, testing and review of information for users](https://www.iso.org/standard/89070.html).
- [ISO/IEC/IEEE 26515:2018, information development in an agile environment](https://committee.iso.org/standard/70880.html).
- [ISO 24495-1:2023, plain-language principles and guidelines](https://www.iso.org/standard/78907.html).

The standards are authoritative. This guide is a project-specific application of their relevant principles.
