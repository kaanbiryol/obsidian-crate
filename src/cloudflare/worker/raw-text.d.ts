declare module '*.js?raw-text' {
	const text: string;
	export default text;
}

declare module '*.b64?raw-text' {
	const text: string;
	export default text;
}

declare module '*.sql?raw' {
	const text: string;
	export default text;
}
