import { ArticleEmbed } from '../../ArticleEmbed';

interface ArticleRendererProps {
  fromAnchor?: string;
  toAnchor?: string;
  articleSourceWikilink: string;
  lensSourcePath: string;
}

export function ArticleRenderer(props: ArticleRendererProps) {
  return <ArticleEmbed {...props} />;
}
