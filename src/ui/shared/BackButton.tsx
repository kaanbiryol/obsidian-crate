import { IconButton } from './IconButton';

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
	return <IconButton className="crate-back-button" size="large" iconSize="l" icon="chevron-left" label={label} onClick={onClick} />;
}
