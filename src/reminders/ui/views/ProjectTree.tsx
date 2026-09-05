import React, { useId, useState } from 'react';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ThemeIcon } from '../../components/theme-icon';
import { BrowseProjectCard } from './BrowseProjectCard';
import type { BrowseProjectCardViewModel } from './viewModels';

export interface ProjectTreeNode {
  path: string;
  label: string;
  card?: BrowseProjectCardViewModel;
  children: ProjectTreeNode[];
}

export function buildProjectTree(cards: BrowseProjectCardViewModel[]): ProjectTreeNode[] {
  const roots: ProjectTreeNode[] = [];
  const nodes = new Map<string, ProjectTreeNode>();
  for (const card of cards) {
    let siblings = roots;
    let path = '';
    for (const label of card.project.split('/')) {
      path = path ? `${path}/${label}` : label;
      let node = nodes.get(path);
      if (!node) {
        node = { path, label, children: [] };
        nodes.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    const node = nodes.get(card.project);
    if (node) node.card = card;
  }
  return roots;
}

export function ProjectTree({ nodes, onProjectSelect }: {
  nodes: ProjectTreeNode[];
  onProjectSelect: (project: string) => void;
}) {
  return <ul className="premium-project-tree">
    {nodes.map(node => <ProjectBranch key={node.path} node={node} onProjectSelect={onProjectSelect} />)}
  </ul>;
}

function ProjectBranch({ node, onProjectSelect }: {
  node: ProjectTreeNode;
  onProjectSelect: (project: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const childrenId = useId();
  return <li className={node.children.length > 0 ? 'premium-project-group' : undefined}>
    <div className="premium-project-tree-row">
      {node.card ? <BrowseProjectCard card={node.card} label={node.label} hideChevron={node.children.length > 0} onClick={() => onProjectSelect(node.path)} />
        : <span className="premium-project-group-name">{node.label}</span>}
      {node.children.length > 0 && <ShadowDOMNativeButton
        className="premium-project-expand"
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.path} subprojects`}
        aria-expanded={expanded}
        aria-controls={childrenId}
        onClick={() => setExpanded(value => !value)}
      >
        <ThemeIcon size="s" id={expanded ? 'chevron-down' : 'chevron-right'} />
      </ShadowDOMNativeButton>}
    </div>
    {node.children.length > 0 && <div id={childrenId} hidden={!expanded} className="premium-project-children">
      <ProjectTree nodes={node.children} onProjectSelect={onProjectSelect} />
    </div>}
  </li>;
}
