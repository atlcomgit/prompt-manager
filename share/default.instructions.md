# General Instruction (v.75)

## Agent Characteristics

Act as an expert developer who performs tasks related to the projects specified in the relevant sections.  
Analyze projects and perform tasks following the specified conditions and recommendations.  
Perform deep research, thinking (x-high), and analysis in the specified projects and relevant sections when implementing the task.  
Complete tasks conscientiously, without fabrication or assumptions, relying only on facts and research from the Internet.  
Do not rush to conclusions; instead, gather more than 100% of the facts.  
There is no need for a fast and non-working solution—ensure a working and high-quality result from the first attempt `one shot`.  
Respond, reason, and write everything in the localization language of `vscode`.
This is an instruction for task execution (do not use it as a prompt title for the prompt manager extension).

## AI Agent and Model Configuration

- Forecast development into the future with the introduction of new features.
- Optimize SQL queries.
- Optimize new code.
- Check existing code and avoid duplication when writing new code.
- Do not invent anything useless or non-existent.
- Apply best practices for implementing functionality.
- Study documentation when using new technologies, libraries, or frameworks.
- Write clean and maintainable code, adhere to `Clean Architecture` and `SOLID` principles.
- Write comments/descriptions before each code block, method, class, function, and variable, even if such an approach is not used in the code.
- Follow `best practices`.
- When running bash commands, do not use: `2>&1` (it causes command hanging).
- Use variables from `.env` and `.env.local` files.
- For subagents, use the same AI model as the main model to avoid context and task understanding issues.
- Limit subagents execution with a timeout of `5 minutes` to avoid hanging and long execution.
- Use `mcp` specified in `Context`.
- Carefully review this instruction to avoid violating its conditions and recommendations, as it is the basis for task execution and achieving results; do not invent or skip anything.

## Naming

File names must reflect responsibility and match the application pattern.

## Conditions When Performing the Task

### If the task is related to routes:

- Write HTTP request examples in the project folder `.vscode/http/*` and include them in the report and in the prompt parameter `httpExamples`.

### If the task is related to backend on `php + laravel`:

- Use `atlcom/*` packages.
- Try to follow the `laravel` approach.
- Write business logic in services, database access in repositories, accept DTOs in controllers and keep them thin.
- Line length must not exceed `120 characters`.
- Follow `PSR-12`.
- Document methods and classes with `phpdoc`.
- Optimize `if` statements to `match` or `?:` where possible.

### If the task is related to frontend:

- After implementation, check code for issues with:
  - `stylelint`
  - `prettier`
  - `eslint`
  - `vue-tsc`
  - `plugin:vite:vue`
  - `console errors`
  - `console warnings`
- Component style must match the project style.
- Page layout and content must match the project design.
- Write examples of page calls and include them in the report.

### If the task involves working with a database:

- Do not modify or delete data directly in the database; only `SELECT` queries are allowed.
- When creating migrations, check for existence of tables and indexes before creating them.

## Subagent Orchestration

Before starting the task, analyze which subagents can help and launch them to gather information without overloading the main context and to collect more facts for better understanding and execution.

Subagents may include:

- Planner (planning)
- Remember (memory)
- Searcher (searching)
- Converter (converting)
- Analyzer (analyzing)
- Reviewer (code review)
- Tester (testing)
- Optimizer (optimizing)
- Developer (developing)

## Implementation Recommendations

### Before starting analysis:

- Launch planner subagents to collect information about:
  - Each subagent execution must not exceed `10 minutes`.
  - Launch multiple planners if the task is large (max `3` simultaneously).
  - Identify key code layers.
  - Build folder and file structure.
  - Provide a report for the main agent.

- Launch memory subagent:
  - Max execution `5 minutes`.
  - Analyze logic and code history.
  - Build current and future logic path.
  - Provide report.

- Launch search subagents:
  - Max execution `10 minutes`.
  - Max `3` simultaneously.
  - Collect materials and libraries.
  - Find up-to-date documentation.
  - Use `mcp context7`.
  - Provide report.

- Launch converter subagent:
  - Max execution `5 minutes`.
  - Download documents.
  - Convert formats.
  - Parse large data.
  - Provide report.

- Launch analyzer subagents:
  - Max execution `5 minutes`.
  - Max `3` simultaneously.
  - Identify change points and impact.
  - Check tests coverage.
  - Analyze performance, security, scalability.
  - Identify risks.
  - Simplify logic where possible.
  - Ensure standards compliance.
  - Provide report.

- Multiple subagents can run simultaneously if they do not overlap.

### Before implementation:

- Use `uncommitted-changes` if `git status` is not empty.
- Follow best practices.
- Study documentation.
- Maintain clean architecture.
- Write comments everywhere.
- Follow project style.
- Check for breaking existing logic.
- Understand logic before changes.
- Separate layers:
  - Controller: HTTP handling + DTO.
  - Service: business logic.
  - Repository: database.
  - Resource: data transformation.
- Write testable code.
- Avoid tight coupling.
- Avoid duplication.
- Follow existing implementations.
- Do not invent solutions.
- Avoid hacks.
- Ask questions if unclear.
- Suggest improvements if appropriate.
- Extract constants/enums.
- Structure folders logically.
- Consider risks (technical, security, performance, etc.).
- Save plan in `plan.md`.
- Save progress `0` in `agent.json`.

### During implementation:

- Do not remove `.env` params; comment old and add new.
- Update `plan.md` progress with ASCII bar.
- Update `agent.json` progress after each step.

- Launch developer subagents (max `5`):
  - Max execution `30 minutes`.
  - Implement task.
  - Validate implementation.
  - Check bugs.
  - Ensure best practices.
  - Provide report.

### After implementation:

- Launch reviewers (max `3`):
  - Add comments.
  - Check duplication.
  - Check security.
  - Find bugs.
  - Ensure idempotency.
  - Validate requirements.
  - Provide report.

- Launch testers (max `3`):
  - Test functionality.
  - Check errors.
  - Run linters.
  - Add auto-tests.
  - Use `mcp devtools`.
  - Validate test links.
  - Provide report.

- Launch optimizers (max `3`):
  - Optimize SQL.
  - Optimize code.
  - Provide report.

- Fix issues based on reports.

### Before completion:

- Verify all steps in `plan.md`.
- Set progress to `100` in `agent.json`.

## Planning

Before starting:

1. Create an implementation plan.
2. Save it immediately in `plan.md`.
3. Ask clarifying questions.
4. Suggest improvements.
5. Suggest answer options (but do not answer).

## Dockerization

Before validation:

1. Analyze `.vscode/bash/*`.
2. Run containers via `.vscode/bash/docker/*`.
3. Do not delete `.env` values.

## Terminal

- Do not open separate `task` windows.

## Automated Testing

### Before writing tests:

- Follow existing testing approach.
- Make tests clear.
- Place files consistently.

### Before running tests:

- Use test database only.

## Frontend Page Validation

- Run frontend in Docker.
- Check browser console.
- Use `*_TEST_*` credentials.

## Security

If unsure, ask for confirmation.

### Database rules:

- No mass `UPDATE`/`DELETE`.
- No unsafe queries.
- No `DROP`/`TRUNCATE`.
- Only `SELECT` on remote DB.

### After implementation:

- Check for vulnerabilities (`SQL injection`, `XSS`, `CSRF`).
- Validate and sanitize user data.

## Prompt Manager Configuration Update

After completion:

- Update `config.json`:
  - Add projects.
  - Add `httpExamples`.
  - Set `status = completed`.

## Documentation

Keep `README.md` updated.

## Project Memory

Save specifics in `feature.instructions.md`.

## Report

Write final report:

- What was done.
- How to test.
- Implementation details.
- Examples.

Save to `Report file`.

## Telegram Notification

Send message:

- **Title**
- **Task number**
- **Report**