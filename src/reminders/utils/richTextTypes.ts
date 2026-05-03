export interface TextMatch {
    text: string;
    index: number;
    length: number;
    type: 'priority' | 'date' | 'project' | 'link';
    linkText?: string;
    linkUrl?: string;
}
