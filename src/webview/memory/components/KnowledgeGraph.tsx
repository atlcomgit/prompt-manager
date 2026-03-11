/**
 * KnowledgeGraph — Renders the component dependency graph as a simple
 * SVG force-directed layout. Shows nodes (components) and edges (relations).
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { KnowledgeGraphData, KnowledgeGraphNode, KnowledgeGraphEdge } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	data: KnowledgeGraphData | null;
	repositories: string[];
	onRequestGraph: (repository?: string) => void;
	t: (key: string) => string;
}

/** Simple force layout positioning for SVG rendering */
function layoutNodes(
	nodes: KnowledgeGraphNode[],
	edges: KnowledgeGraphEdge[],
	width: number,
	height: number,
): Map<string, { x: number; y: number }> {
	const positions = new Map<string, { x: number; y: number }>();
	const n = nodes.length;
	if (n === 0) { return positions; }

	// Initial placement: circular
	nodes.forEach((node, i) => {
		const angle = (2 * Math.PI * i) / n;
		const r = Math.min(width, height) * 0.35;
		positions.set(node.id, {
			x: width / 2 + r * Math.cos(angle),
			y: height / 2 + r * Math.sin(angle),
		});
	});

	// Simple force simulation (30 iterations)
	for (let iter = 0; iter < 30; iter++) {
		// Repulsion between all nodes
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const a = positions.get(nodes[i].id)!;
				const b = positions.get(nodes[j].id)!;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
				const force = 2000 / (dist * dist);
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				a.x -= fx; a.y -= fy;
				b.x += fx; b.y += fy;
			}
		}

		// Attraction along edges
		for (const edge of edges) {
			const a = positions.get(edge.source);
			const b = positions.get(edge.target);
			if (!a || !b) { continue; }
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
			const force = (dist - 120) * 0.01;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.x += fx; a.y += fy;
			b.x -= fx; b.y -= fy;
		}

		// Keep within bounds
		for (const pos of positions.values()) {
			pos.x = Math.max(40, Math.min(width - 40, pos.x));
			pos.y = Math.max(40, Math.min(height - 40, pos.y));
		}
	}

	return positions;
}

export const KnowledgeGraph: React.FC<Props> = ({ data, repositories, onRequestGraph, t }) => {
	const [selectedRepo, setSelectedRepo] = useState('');
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 600, height: 400 });

	// Measure container
	useEffect(() => {
		if (containerRef.current) {
			const rect = containerRef.current.getBoundingClientRect();
			setDimensions({ width: rect.width || 600, height: rect.height || 400 });
		}
	}, [data]);

	// Compute positions
	const positions = useMemo(() => {
		if (!data) { return new Map(); }
		return layoutNodes(data.nodes, data.edges, dimensions.width, dimensions.height);
	}, [data, dimensions]);

	return (
		<div style={styles.container} ref={containerRef}>
			<div style={styles.toolbar}>
				{repositories.length > 1 && (
					<select
						style={styles.select}
						value={selectedRepo}
						onChange={e => {
							setSelectedRepo(e.target.value);
							onRequestGraph(e.target.value || undefined);
						}}
					>
						<option value="">{t('memory.allRepositories')}</option>
						{repositories.map(r => <option key={r} value={r}>{r}</option>)}
					</select>
				)}
				<button style={memoryButtonStyles.secondary} onClick={() => onRequestGraph(selectedRepo || undefined)}>
					↻ {t('memory.refresh')}
				</button>
			</div>

			{!data || (data.nodes.length === 0 && data.edges.length === 0) ? (
				<div style={styles.empty}>{t('memory.noGraphData')}</div>
			) : (
				<svg width={dimensions.width} height={dimensions.height} style={styles.svg}>
					{/* Edges */}
					{data.edges.map((edge, i) => {
						const from = positions.get(edge.source);
						const to = positions.get(edge.target);
						if (!from || !to) { return null; }
						return (
							<line
								key={`e-${i}`}
								x1={from.x} y1={from.y}
								x2={to.x} y2={to.y}
								stroke="var(--vscode-editorLineNumber-foreground)"
								strokeWidth={Math.min(edge.weight, 4)}
								strokeOpacity={0.5}
							/>
						);
					})}

					{/* Nodes */}
					{data.nodes.map(node => {
						const pos = positions.get(node.id);
						if (!pos) { return null; }
						const r = 8 + Math.min(node.weight * 2, 16);
						return (
							<g key={node.id}>
								<circle
									cx={pos.x} cy={pos.y} r={r}
									fill="var(--vscode-button-background)"
									opacity={0.8}
								/>
								<text
									x={pos.x} y={pos.y + r + 12}
									textAnchor="middle"
									fill="var(--vscode-foreground)"
									fontSize="10"
								>
									{node.label}
								</text>
							</g>
						);
					})}
				</svg>
			)}
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	container: { display: 'flex', flexDirection: 'column', height: '100%', padding: '16px' },
	toolbar: { display: 'flex', gap: '8px', marginBottom: '12px', flexShrink: 0 },
	select: {
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '3px',
		padding: '4px 8px', fontSize: '12px',
	},
	empty: {
		flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
		color: 'var(--vscode-descriptionForeground)',
	},
	svg: { flex: 1, background: 'var(--vscode-editor-background)', borderRadius: '4px' },
};
