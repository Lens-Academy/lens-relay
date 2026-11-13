// The part of elkjs the concept map uses (lib/idea-map-elk). Declared here so
// the code type-checks whether or not the package's own types are found.
declare module 'elkjs/lib/elk.bundled.js' {
  export interface ElkPoint { x: number; y: number }
  export interface ElkSection { startPoint: ElkPoint; endPoint: ElkPoint; bendPoints?: ElkPoint[] }
  export interface ElkEdge { id: string; sources: string[]; targets: string[]; sections?: ElkSection[] }
  export interface ElkNode {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutOptions?: Record<string, string>;
    children?: ElkNode[];
    edges?: ElkEdge[];
  }
  export default class ELK {
    layout(graph: ElkNode): Promise<ElkNode>;
  }
}
