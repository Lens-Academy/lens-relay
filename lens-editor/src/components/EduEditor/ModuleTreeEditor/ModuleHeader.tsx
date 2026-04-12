interface ModuleHeaderProps {
  title: string;
  slug?: string;
  tags?: string;
}

export function ModuleHeader({ title, slug, tags }: ModuleHeaderProps) {
  return (
    <div className="px-3 py-2.5 mb-2 rounded-md border border-[#e4e0d4] bg-white">
      <div style={{ fontFamily: "'Newsreader', serif", fontSize: '15px', fontWeight: 700, color: '#1a1a1a' }}>
        {title}
      </div>
      {(slug || tags) && (
        <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
          {slug && `slug: ${slug}`}
          {slug && tags && ' · '}
          {tags && `tags: ${tags}`}
        </div>
      )}
    </div>
  );
}
