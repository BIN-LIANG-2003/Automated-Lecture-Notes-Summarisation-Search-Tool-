const WORKSPACE_IMAGE_ICON_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;

export const isWorkspaceImageIcon = (value) => {
  const safeValue = String(value || '').trim();
  return WORKSPACE_IMAGE_ICON_PATTERN.test(safeValue);
};

export default function WorkspaceIcon({
  value = '',
  fallback = 'W',
  large = false,
  className = '',
}) {
  const safeValue = String(value || '').trim();
  const fallbackText = String(fallback || 'W').trim().slice(0, 1).toUpperCase() || 'W';
  const isImage = isWorkspaceImageIcon(safeValue);
  const labelSource = safeValue.toLowerCase().startsWith('data:') ? '' : safeValue;
  const label = labelSource ? labelSource.slice(0, 2) : fallbackText;
  const classNames = [
    'notion-avatar',
    large ? 'notion-avatar-large' : '',
    isImage ? 'is-image' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <span className={classNames} aria-hidden="true">
      {isImage ? <img src={safeValue} alt="" draggable="false" /> : label}
    </span>
  );
}
