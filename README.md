# Prompt Manager for VS Code

<p align="center">
  <img src="media/icon.png" alt="Prompt Manager" width="128" height="128">
</p>

<p align="center">
  <strong>Управляйте, организуйте и используйте AI-промпты прямо в VS Code</strong><br>
  с интеграцией GitHub Copilot Chat
</p>

---

## ✨ Возможности

### 📋 Управление промптами
- Создание, редактирование, удаление и дублирование промптов
- Хранение промптов в `.vscode/prompt-manager/` — версионируется через Git
- Автогенерация названий и описаний через AI
- Импорт и экспорт промптов

### 🔍 Поиск и фильтрация
- Полнотекстовый поиск по названию и описанию
- Фильтрация по статусу (Черновик, В работе, Завершён, Остановлен)
- Сортировка по названию, дате создания, дате изменения
- Группировка по статусу, проектам, языкам, фреймворкам
- Избранные промпты для быстрого доступа

### ⚙️ Настройка промпта
- Текст промпта в формате **Markdown** с поддержкой шаблонных переменных `{{variable}}`
- Выбор **проектов рабочей области**, языков программирования и фреймворков
- Подключение **скиллов** (`.vscode/skills/`, `~/.copilot/skills/`)
- Подключение **MCP инструментов** из конфигурации рабочей области
- Подключение и запуск **hooks** (`.vscode/hooks/`, `~/.copilot/hooks/`) до отправки и после завершения ответа чата
- Выбор **модели AI** для использования в чате
- Прикрепление **файлов контекста** к промпту
- Привязка к **задачам трекера** и **веткам Git**
- Трекинг статуса работы с промптом

### 💬 Интеграция с Copilot Chat
- Отправка промптов в GitHub Copilot Chat одним нажатием
- Связь промптов с чат-сессиями
- Открытие существующего чата по промпту

### 🔀 Работа с Git
- Просмотр и переключение веток в выбранных проектах
- Проверка несохранённых изменений перед переключением
- Автоматическое создание веток в проектах

### ⏱ Аналитика
- Трекинг времени написания промпта
- Трекинг времени реализации в чате
- Анализ эффективности промптов

---

## 🚀 Быстрый старт

### Установка
1. Откройте VS Code
2. Перейдите в **Extensions** (`Ctrl+Shift+X`)
3. Найдите **"Prompt Manager"**
4. Нажмите **Install**

### Использование
1. Откройте иконку **Prompt Manager** в Activity Bar (боковая панель)
2. Нажмите **"＋ Новый"** для создания промпта
3. Заполните форму настройки промпта
4. Нажмите **"💾 Сохранить"**
5. Нажмите **"🚀 Начать чат"** для отправки в Copilot

---

## 📁 Структура хранения

Промпты сохраняются в папке `.vscode/prompt-manager/`:

```
.vscode/prompt-manager/
├── my-prompt-slug/
│   ├── config.json      # Настройки промпта
│   ├── prompt.md        # Текст промпта (Markdown)
│   └── context/         # Прикреплённые файлы
├── another-prompt/
│   ├── config.json
│   ├── prompt.md
│   └── context/
```

### 🛠 config.json
```json
{
  "id": "my-prompt-slug",
  "title": "Рефакторинг компонентов",
  "description": "Промпт для рефакторинга React компонентов",
  "status": "in-progress",
  "favorite": true,
  "projects": ["frontend"],
  "languages": ["TypeScript"],
  "frameworks": ["React"],
  "skills": ["devtools"],
  "mcpTools": ["context7"],
  "hooks": [],
  "taskNumber": "JIRA-123",
  "branch": "feature/refactor",
  "model": "copilot/gpt-4o",
  "contextFiles": ["src/components/App.tsx"],
  "chatSessionIds": [],
  "timeSpentWriting": 300000,
  "timeSpentImplementing": 1200000,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-02T00:00:00.000Z"
}
```

---

## ⌨️ Команды

| Команда | Описание |
|---------|----------|
| `Prompt Manager: Create New Prompt` | Создать новый промпт |
| `Prompt Manager: Open Prompt` | Открыть промпт из списка |
| `Prompt Manager: Delete Prompt` | Удалить промпт |
| `Prompt Manager: Duplicate Prompt` | Дублировать промпт |
| `Prompt Manager: Import Prompt` | Импортировать промпт из папки |
| `Prompt Manager: Export Prompt` | Экспортировать промпт в папку |
| `Prompt Manager: Refresh Prompt List` | Обновить список промптов |
| `Prompt Manager: Start Chat with Prompt` | Начать чат с промптом |

---


---

## 📄 Лицензия

MIT © alek

---

<p align="center">
  Made with ⚡ for VS Code
</p>
