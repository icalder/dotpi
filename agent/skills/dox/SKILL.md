---
name: dox
description: This skill enables the agent to initialize the DOX project context framework. DOX helps agents maintain precise project context through a hierarchy of AGENTS.md files.
---

# DOX Setup Skill


This skill enables the agent to initialize the DOX project context framework. DOX helps agents maintain precise project context through a hierarchy of AGENTS.md files.

## Goal
Set up the DOX framework in the current project root.

## Instructions
1. **Check for existing AGENTS.md**: Check if an `AGENTS.md` file already exists in the project root.
2. **Apply DOX instructions**:
    - **If AGENTS.md does NOT exist**: Create the file and copy the entire content of `/home/itcalde/.pi/agent/skills/dox/dox-AGENTS.md` into it.
    - **If AGENTS.md DOES exist**: Append the entire content of `/home/itcalde/.pi/agent/skills/dox/dox-AGENTS.md` to the end of the existing `AGENTS.md` file.
3. **Confirmation**: Inform the user that DOX has been initialized.
4. **Next Step**: Suggest to the user that they can now ask you to "Initialize DOX tree for this project now" to create the necessary child documentation and indexes.
