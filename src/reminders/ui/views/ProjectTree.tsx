import React, { useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
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
  return <Collapsible.Root render={<li />} open={expanded} onOpenChange={setExpanded} className={node.children.length > 0 ? 'premium-project-group' : undefined}>
    <div className="premium-project-tree-row">
      {node.card ? <BrowseProjectCard card={node.card} label={node.label} hideChevron={node.children.length > 0} onClick={() => onProjectSelect(node.path)} />
        : <span className="premium-project-group-name">{node.label}</span>}
      {node.children.length > 0 && <Collapsible.Trigger
        className="premium-project-expand"
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.path} subprojects`}
      >
        <ThemeIcon size="s" id={expanded ? 'chevron-down' : 'chevron-right'} />
      </Collapsible.Trigger>}
    </div>
    {node.children.length > 0 && <Collapsible.Panel keepMounted className="premium-project-children">
      <ProjectTree nodes={node.children} onProjectSelect={onProjectSelect} />
    </Collapsible.Panel>}
  </Collapsible.Root>;
}
