/**
 * Компактный виджет команд для вставки в чат выбранного агента.
 * Двойной щелчок или активация с клавиатуры передаёт текст как черновик.
 */
import React, { useEffect, useState } from 'react';
import type { DashboardQuickCommandTarget } from '../../../types/promptDashboardPreferences.js';

/** Available destinations for a quick command draft. */
const TARGETS: Array<{ value: DashboardQuickCommandTarget; label: string }> = [
    { value: 'copilot', label: 'Copilot' },
    { value: 'codex', label: 'OpenAI Codex' },
    { value: 'claude', label: 'Claude Code' },
    { value: 'opencode-cli', label: 'OpenCode CLI' },
];

/** Edits the shared command list and uses the selected destination for every phrase. */
export function QuickCommandsWidget(props: {
    items: string[];
    target: DashboardQuickCommandTarget;
    onTargetChange(target: DashboardQuickCommandTarget): void;
    onItemsChange(items: string[]): void;
    onInsert(text: string, target: DashboardQuickCommandTarget): void;
}): React.ReactElement {
    const { target } = props;
    // Persisted commands are unique. The original text identifies the row while its draft is open.
    const [editingCommand, setEditingCommand] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [adding, setAdding] = useState(false);
    const [filter, setFilter] = useState('');
    useEffect(() => {
        if (editingCommand !== null && !props.items.includes(editingCommand)) {
            setEditingCommand(null);
            setDraft('');
        }
    }, [editingCommand, props.items]);

    /** Завершает добавление или редактирование только валидной и уникальной фразой. */
    const save = () => {
        const text = draft.trim();
        if (!text || text.length > 3000) return;
        const next = [...props.items];
        if (editingCommand !== null) {
            const index = next.indexOf(editingCommand);
            if (index < 0) return;
            next[index] = text;
        } else {
            next.push(text);
        }
        props.onItemsChange([...new Set(next)]);
        setEditingCommand(null);
        setAdding(false);
        setDraft('');
    };
    const filtered = props.items.map((text, index) => ({ text, index }))
        .filter(item => item.text.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
    return (
        <div className="pm-quick-commands">
            <style>{'\n/* Global quick-command widget: compact, keyboard-friendly, no timers while hidden. */\n.pm-quick-commands { display: flex; flex-direction: column; gap: 7px; min-width: 0; }\n.pm-quick-commands-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 7px; }\n.pm-quick-commands-controls label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }\n.pm-quick-commands select, .pm-quick-commands input, .pm-quick-commands textarea {\n\tfont: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);\n\tborder: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;\n\tpadding: 5px 7px; min-width: 0; box-sizing: border-box;\n}\n.pm-quick-commands-controls input { flex: 1; min-width: 90px; }\n.pm-quick-commands-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow-y: auto; }\n.pm-quick-commands-row { display: flex; align-items: stretch; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }\n.pm-quick-commands-run { flex: 1; min-width: 0; padding: 8px; background: transparent; text-align: left;\n\tcolor: var(--vscode-foreground); border: 0; cursor: pointer; white-space: pre-wrap; overflow-wrap: anywhere;\n\tfont: inherit; font-size: 12px; }\n.pm-quick-commands-run:hover { background: var(--vscode-list-hoverBackground); }\n.pm-quick-commands-icon { border: 0; border-left: 1px solid var(--vscode-panel-border); background: transparent;\n\tcolor: var(--vscode-foreground); padding: 4px 8px; cursor: pointer; }\n.pm-quick-commands-icon:hover { background: var(--vscode-list-hoverBackground); }\n.pm-quick-commands-edit { display: flex; flex-wrap: wrap; gap: 5px; }\n.pm-quick-commands-edit textarea { flex: 1 1 100%; resize: vertical; }\n.pm-quick-commands-edit button { padding: 5px 8px; color: var(--vscode-button-foreground);\n\tbackground: var(--vscode-button-background); border: 0; border-radius: 4px; cursor: pointer; }\n'}</style>
            <div className="pm-quick-commands-controls">
                <label>Агент
                    <select value={target} onChange={event => props.onTargetChange(event.target.value as DashboardQuickCommandTarget)}
                        aria-label="Целевой чат агента">
                        {TARGETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                </label>
                <input value={filter} onChange={event => setFilter(event.target.value)}
                    aria-label="Фильтр быстрых команд" placeholder="Поиск команды…"/>
                <button type="button" className="pm-qn-btn is-secondary"
                    title="Добавить быструю команду"
                    onClick={() => { setAdding(true); setEditingCommand(null); setDraft(''); }}>+</button>
            </div>
            <div className="pm-quick-commands-list">
                {filtered.length === 0 && !adding && <span className="pm-qn-muted">Команд пока нет.</span>}
                {filtered.map(item => editingCommand === item.text ? (
                    <div className="pm-quick-commands-edit" key={item.text}>
                        <textarea rows={2} value={draft} aria-label="Редактировать быструю команду"
                            onChange={event => setDraft(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
                                if (event.key === 'Escape') { setEditingCommand(null); setDraft(''); }
                            }} />
                        <button type="button" onClick={save} disabled={!draft.trim()}>Сохранить</button>
                        <button type="button" onClick={() => setEditingCommand(null)}>Отмена</button>
                    </div>
                ) : (
                    <div className="pm-quick-commands-row" key={item.text}>
                        <button type="button" className="pm-quick-commands-run" title="Двойной щелчок или Enter — вставить без отправки"
                            onClick={event => { if (event.detail === 0) props.onInsert(item.text, target); }}
                            onDoubleClick={() => props.onInsert(item.text, target)}>{item.text}</button>
                        <button type="button" className="pm-quick-commands-icon" aria-label="Изменить команду"
                            onClick={() => { setAdding(false); setEditingCommand(item.text); setDraft(item.text); }}>✎</button>
                        <button type="button" className="pm-quick-commands-icon" aria-label="Удалить команду"
                            onClick={() => props.onItemsChange(props.items.filter((_, i) => i !== item.index))}>×</button>
                    </div>
                ))}
            </div>
            {adding && (
                <div className="pm-quick-commands-edit">
                    <textarea rows={2} autoFocus value={draft} aria-label="Новая быстрая команда"
                        placeholder="Введите команду или фразу…"
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
                            if (event.key === 'Escape') { setAdding(false); setDraft(''); }
                        }}/>
                    <button type="button" onClick={save} disabled={!draft.trim()}>Сохранить</button>
                    <button type="button" onClick={() => setAdding(false)}>Отмена</button>
                </div>
            )}
        </div>
    );
}
