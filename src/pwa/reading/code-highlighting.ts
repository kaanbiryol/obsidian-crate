import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import swift from 'highlight.js/lib/languages/swift';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import dart from 'highlight.js/lib/languages/dart';
import r from 'highlight.js/lib/languages/r';
import matlab from 'highlight.js/lib/languages/matlab';
import julia from 'highlight.js/lib/languages/julia';
import lua from 'highlight.js/lib/languages/lua';
import perl from 'highlight.js/lib/languages/perl';
import scala from 'highlight.js/lib/languages/scala';
import objectivec from 'highlight.js/lib/languages/objectivec';
import powershell from 'highlight.js/lib/languages/powershell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import graphql from 'highlight.js/lib/languages/graphql';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';

for (const [name, grammar] of Object.entries({ javascript, typescript, python, bash, json, css, xml, sql, yaml, go, rust, swift,
	java, kotlin, c, cpp, csharp, ruby, php, dart, r, matlab, julia, lua, perl, scala, objectivec, powershell, dockerfile, ini, markdown, diff, graphql, scss, shell
})) {
	hljs.registerLanguage(name, grammar);
}

hljs.registerAliases('objective-c', { languageName: 'objectivec' });

/** Runs only in the PWA. Highlight.js escapes source text before adding token spans. */
export function highlightReadingCode(code: string, language: string): string | undefined {
	if (!code.trim() || code.length > 20_000) return undefined;
	if (language && !hljs.getLanguage(language)) return undefined;
	try {
		if (language) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
		// Detection is useful for clipped articles without a fence label, but keep it bounded on phones.
		if (code.length > 5_000) return undefined;
		const result = hljs.highlightAuto(code, ['javascript', 'python', 'bash', 'json', 'css', 'xml', 'sql', 'swift']);
		return result.relevance >= 3 ? result.value : undefined;
	} catch {
		return undefined;
	}
}
