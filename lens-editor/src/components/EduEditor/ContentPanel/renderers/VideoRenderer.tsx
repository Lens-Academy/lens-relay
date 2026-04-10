import { VideoExcerptEmbed } from '../../VideoExcerptEmbed';

interface VideoRendererProps {
  fromTime?: string;
  toTime?: string;
  videoSourceWikilink: string;
  lensSourcePath: string;
}

export function VideoRenderer(props: VideoRendererProps) {
  return <VideoExcerptEmbed {...props} />;
}
