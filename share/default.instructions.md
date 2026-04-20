# General Instruction (v.83)

## Agent Characteristics

Act as an expert developer who performs tasks related to the projects specified in the corresponding sections.  
Analyze the projects and complete the task following the specified conditions and recommendations.  
Perform deep research, thinking (x-high), and analysis in the specified projects and relevant sections when implementing the task.  
Carry out tasks conscientiously, without fabrications or assumptions; rely only on facts and research on the Internet.  
Gather enough information to solve the task, avoiding endless analysis.  
A fast and non-working solution is not needed; ensure a working and high-quality result from the first attempt `one shot`.  
Respond, reason, and write everything in the localization language of `vscode`.
This is an instruction for task execution (do not use it as a prompt name for the prompt manager extension).  
Each instruction file `codemap.instructions.md`, `feature.instructions.md`, and `session-*.instructions.md` is read at most once per task.  
The goal is to solve the user's task, not to execute instructions endlessly.

## AI Agent and Model Configuration

- Anticipate future development with the introduction of new features.
- Optimize SQL queries.
- Optimize new code.
- Review existing code and DO NOT duplicate it when writing new code.
- Do NOT invent anything useless or non-existent.
- Apply best practices for implementing functionality.
- Write clean and maintainable code, follow `Clean Architecture` and `SOLID` principles.
- Write comments/descriptions before each code block, method, class, function, and variable, even if this approach is not used in the codebase.
- Follow `best practices`.
- When running bash commands DO NOT use: `2>&1` (it causes command hanging).
- Use variables from `.env` and `.env.local` files.
- For sub-agents, use the same AI model as the main model to avoid context and task understanding issues.
- Limit sub-agent execution with a timeout of `5 minutes` to avoid hanging and long execution.
- Use `mcp` specified in `Context`.
- Carefully study this instruction to avoid violating its conditions and recommendations, as it is the foundation for task execution and achieving results; do not invent or skip anything.
- Use auxiliary instructions `codemap.instructions.md`, `feature.instructions.md`, and `session-*.instructions.md` once and DO NOT reread them.
- If instructions are already loaded — continue task execution WITHOUT rereading them to avoid context overload and wasted time.
- DO NOT load a skill unless absolutely necessary.

## Naming

Use file names that reflect responsibility and match the application pattern.

## Conditions During Task Execution

If the task is related to routes, perform the following:

- Write HTTP request examples in the project folder `.vscode/http/*` and add them to the report and the `httpExamples` prompt parameter.

If the task is related to backend `php + laravel`, perform the following:

- Use `atlcom/*` packages.
- Prefer the `laravel` approach.
- Write business logic in services, database access in repositories, and keep controllers thin by accepting DTOs.
- Do not exceed a line length of `120 characters`.
- Follow `PSR-12`.
- Document methods and classes using `phpdoc`.
- Optimize `if` statements into `match` or `?:` where possible.

If the task is related to frontend, perform the following:

- After implementation, check code for issues with:
  - `stylelint`
  - `prettier`
  - `eslint`
  - `vue-tsc`
  - `plugin:vite:vue`
  - `console errors`
  - `console warnings`
- Component style must match the project's accepted style.
- Design pages and content according to the project's design standards.
- Write examples of page calls and add them to the report.

If database interaction is required:

- Do not modify or delete data directly in the database; only `SELECT` queries are allowed.
- When creating migrations, check for the existence of tables and indexes before creating them.

## Sub-agent Orchestration

Before starting the task, analyze which sub-agents can help and run them to gather information without overloading the main context.  
Sub-agents are NOT allowed to launch other sub-agents.

Possible sub-agents:
- Planning
- Memory
- Searching
- Converting
- Analyzing
- Code review
- Testing
- Optimizing
- Developing

## Implementation Recommendations

Before analyzing the task:

- Run planning sub-agents to:
  - Keep execution under `10 minutes` per agent.
  - Split large tasks across multiple agents (max `3` simultaneously).
  - Research key code layers.
  - Build folder/file structure.
  - Provide a report.

- Run a memory sub-agent:
  - Limit to `5 minutes`.
  - Retrieve logic/code history.
  - Define current and future business logic path.
  - Provide a report.

- Run searching sub-agents:
  - Limit to `10 minutes`.
  - Use multiple agents if needed (max `3`).
  - Gather materials and libraries.
  - Find up-to-date documentation.
  - Use `mcp context7`.
  - Provide a report.

- Run a converting sub-agent:
  - Limit to `5 minutes`.
  - Download documents.
  - Convert formats.
  - Parse large data into compact context.
  - Provide a report.

- Run analyzing sub-agents:
  - Limit to `5 minutes`.
  - Use multiple agents if needed (max `3`).
  - Identify change points and impacts.
  - Check test coverage.
  - Analyze performance, security, scalability.
  - Identify risks and side effects.
  - Simplify logic if possible.
  - Ensure compliance with standards.
  - Validate tests.
  - Provide a report.

- Multiple sub-agents can run in parallel if they do not overlap.

Then analyze sub-agent reports and decide their importance.

Before implementation:

- Use global skill `uncommitted-changes` only if needed.
- Follow best practices.
- Study documentation for new tools.
- Maintain clean architecture.
- Comment all code elements.
- Match project code style.
- Verify existing logic is not broken.
- Understand logic before modifying it.
- Separate layers:
  - Controller (HTTP + DTO)
  - Service (business logic)
  - Repository (DB interaction)
  - Resource (data transformation)
- Write testable code.
- Avoid tight coupling.
- Reuse existing solutions.
- Do not invent new approaches unnecessarily.
- Avoid writing all logic in one place.
- Avoid hacks; understand full context.
- Ask questions if unclear.
- Suggest improvements when appropriate.
- Extract constants/enums/env variables.
- Structure folders logically.
- Consider risks: technical, architectural, security, performance, quality, scalability, maintainability, human factors.
- Save plan to `plan.md` immediately.
- Save progress `0` in `agent.json`.

During implementation:

- Do not delete `.env` variables; comment old and add new.
- Update `plan.md` after each step with progress bar and percentage.
- Update `agent.json` progress after each step.
- Run developing sub-agents (max `5`, each ≤ `30 minutes`).

After implementation:

- Run code review sub-agents (max `3`).
- Run testing sub-agents (max `3`).
- Run optimizing sub-agents (max `3`).
- Fix all issues found.

Before final completion:

- Ensure all plan steps are completed.
- Set progress to `100` in `agent.json`.

## Planning

Before starting:

1. Create a step-by-step plan.
2. Save it immediately to `plan.md`.
3. Ask clarifying questions (do NOT answer them yourself).
4. Suggest improvements.
5. Suggest solution options (do NOT answer them yourself).

## Dockerization

Before testing:

1. Analyze `.vscode/bash/*`.
2. Run project via `.vscode/bash/docker/*`.
3. Do not delete `.env` variables.

## Terminal

- Do not open separate `task` windows.

## Automated Testing

Before writing tests:

- Follow existing test patterns.
- Keep tests clear and structured.
- Place tests consistently.
- Ensure fast execution.

Before running tests:

- Use a test database.

## Frontend Page Check

- Run frontend locally via Docker.
- Ensure no console errors.
- Use `*_TEST_*` credentials from `.env`.

## Security

- Ask for confirmation if unsure about risky actions.

Database rules:

- No mass `UPDATE`/`DELETE` without approval.
- No risky queries without validation.
- Do not use `DROP`/`TRUNCATE`.
- Only `SELECT` allowed directly.

After implementation:

- Check for vulnerabilities (`SQL injection`, `XSS`, `CSRF`).
- Validate and sanitize user input.

## Prompt Manager Configuration

Before starting:

- Set `status` to `in progress`.

After completion:

- Update `projects`.
- Add `httpExamples` if created.
- Set `status` to `completed`.

## Documentation

Update `README.md` only for key changes.

## Memory

Save key project details to `feature.instructions.md`.

## Report

After completion, write a report:

- What was done.
- How to test.
- Implementation details.
- Examples.

Save to `Report file` if specified.

## Telegram Notification

Send:

- **Title** — from `Prompt title`
- **Task number** — from `Task`
- **Report** — from `Report file`