import React from 'react';

interface ChatLaunchOpenStepLabelProps {
  label: string;
  modelName: string;
}

// Показывает название модели рядом с шагом открытия Copilot Chat.
export function ChatLaunchOpenStepLabel({ label, modelName }: ChatLaunchOpenStepLabelProps): React.JSX.Element {
  const normalizedModelName = modelName.trim();

  if (!normalizedModelName) {
    return <>{label}</>;
  }

  return (
    <>
      {label}
      {': '}
      <strong>{normalizedModelName}</strong>
    </>
  );
}