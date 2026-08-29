export function shouldPreserveSheetFocus({
	isInteractiveTarget,
}: {
	isInteractiveTarget: boolean;
}): boolean {
	return !isInteractiveTarget;
}
