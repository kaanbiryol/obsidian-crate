import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { highlightReadingCode } from './code-highlighting';

describe('Article code highlighting', () => {
	it.each(['javascript', 'js', 'typescript', 'ts'])('colors %s without changing copyable text', language => {
		const source = 'const greeting = "hello <world> & friends";\n';
		const html = highlightReadingCode(source, language);
		expect(html).toContain('hljs-keyword');
		const { document } = parseHTML(`<html><body><pre><code>${html}</code></pre></body></html>`);
		expect(document.querySelector('code')?.textContent).toBe(source);
		expect(document.querySelector('world')).toBeNull();
	});
	it.each([
		['java', 'public class Hello { String greeting = "hello"; }'],
		['kotlin', 'fun main() { println("hello") }'],
		['c', 'int main(void) { return 0; }'],
		['cpp', 'int main() { std::cout << "hello"; }'],
		['c++', 'int main() { return 0; }'],
		['csharp', 'public class Hello { string greeting = "hello"; }'],
		['c#', 'public class Hello { string greeting = "hello"; }'],
		['ruby', 'def greet\n  puts "hello"\nend'],
		['php', '<?php echo "hello"; ?>'],
		['dart', 'void main() { print("hello"); }'],
		['r', 'values <- c(1, 2, 3)'],
		['matlab', 'x = [1, 2, 3]; % sample'],
		['julia', 'function greet()\n println("hello")\nend'],
		['lua', 'local greeting = "hello"'],
		['perl', 'my $greeting = "hello";'],
		['scala', 'val greeting: String = "hello"'],
		['objective-c', '@interface Hello : NSObject\n@end'],
		['powershell', 'Write-Host "hello"'],
		['dockerfile', 'FROM alpine:latest\nRUN echo "hello"'],
		['ini', '[settings]\nname = "hello"'],
		['toml', '[settings]\nname = "hello"'],
		['markdown', '# Heading\n**hello**'],
		['diff', '@@ -1 +1 @@\n-old\n+new'],
		['graphql', 'query { user(id: 1) { name } }'],
		['scss', '$accent: red; .hello { color: $accent; }'],
		['shell', '$ echo "hello"'],
		['jsx', 'const hello = <div>Hello</div>;'],
		['tsx', 'const hello = <div>Hello</div>;'],
	])('renders %s tutorial examples without changing source text', (language, source) => {
		const html = highlightReadingCode(source, language);
		expect(html).toContain('hljs-');
		const { document } = parseHTML(`<html><body><pre><code>${html}</code></pre></body></html>`);
		expect(document.querySelector('code')?.textContent).toBe(source);
	});
	it('highlights SwiftUI examples with and without a language label', () => {
		const source = 'import SwiftUI\n\npublic struct PrimaryButton: View {\n    var body: some View {\n        Text("Continue")\n    }\n}\n';
		for (const language of ['swift', '']) {
			const html = highlightReadingCode(source, language);
			expect(html).toContain('hljs-keyword');
			expect(html).toContain('hljs-string');
			const { document } = parseHTML(`<html><body><pre><code>${html}</code></pre></body></html>`);
			expect(document.querySelector('code')?.textContent).toBe(source);
		}
	});
	it('escapes HTML examples rather than creating executable elements', () => {
		const source = '<script>alert("hello")</script>';
		const { document } = parseHTML(`<html><body>${highlightReadingCode(source, 'html')}</body></html>`);
		expect(document.querySelector('script')).toBeNull();
		expect(document.body.textContent).toBe(source);
	});
	it('detects unlabelled code and leaves unknown, plain and oversized blocks alone', () => {
		expect(highlightReadingCode('const greeting = "hello";\nconsole.log(greeting);', '')).toContain('hljs-');
		for (const language of ['unknown-language', 'text', 'plaintext']) expect(highlightReadingCode('const a = 1;', language)).toBeUndefined();
		expect(highlightReadingCode('x'.repeat(20_001), 'js')).toBeUndefined();
		expect(highlightReadingCode('x'.repeat(5_001), '')).toBeUndefined();
	});
});
