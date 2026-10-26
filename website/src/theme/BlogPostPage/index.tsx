import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { HtmlClassNameProvider, ThemeClassNames } from '@docusaurus/theme-common';
import { BlogPostProvider, useBlogPost } from '@docusaurus/plugin-content-blog/client';
import BlogPostPageMetadata from '@theme/BlogPostPage/Metadata';
import BlogPostPageStructuredData from '@theme/BlogPostPage/StructuredData';
import ContentVisibility from '@theme/ContentVisibility';
import TOCInline from '@theme/TOCInline';
import MDXContent from '@theme/MDXContent';
import type { Props } from '@theme/BlogPostPage';
import { formatDate } from '@site/src/components/Journal/posts';
import SocialMeta from '@site/src/components/Journal/SocialMeta';
import { ProgressBar, leftLabel, useReadingProgress } from '@site/src/components/Journal/ReadingProgress';
import ListenPlayer from '@site/src/components/Journal/ListenPlayer';
import '@site/src/components/Journal/journal.css';

function useCopy(): [string, (fn: () => Promise<string>) => void] {
  const [state, setState] = useState('');
  return [state, (fn) => {
    fn()
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => setState('copied'))
      .catch(() => setState('failed'))
      .finally(() => setTimeout(() => setState(''), 2200));
  }];
}

function ArticleTools({ permalink, url, title }: { permalink: string; url: string; title: string }): React.ReactElement {
  const [mdState, copyMd] = useCopy();
  const [linkState, copyLink] = useCopy();
  const mdUrl = `${permalink}.md`;
  const share = encodeURIComponent(url);
  return (
    <div className="mj-tools" aria-label="Share and export">
      <button type="button" onClick={() => copyMd(() => fetch(mdUrl).then((r) => { if (!r.ok) throw new Error(); return r.text(); }))}>
        {mdState === 'copied' ? 'Copied Markdown' : mdState === 'failed' ? 'Copy failed' : 'Copy as Markdown'}
      </button>
      <a href={mdUrl}>View .md</a>
      <button type="button" onClick={() => copyLink(async () => url)}>{linkState === 'copied' ? 'Link copied' : 'Copy link'}</button>
      <a href={`https://x.com/intent/post?url=${share}&text=${encodeURIComponent(title)}`} target="_blank" rel="noopener noreferrer">Share on X</a>
      <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${share}`} target="_blank" rel="noopener noreferrer">LinkedIn</a>
    </div>
  );
}

function Article({ sidebar, children }: { sidebar: Props['sidebar']; children: React.ReactNode }): React.ReactElement {
  const { metadata, toc, assets } = useBlogPost();
  const { siteConfig } = useDocusaurusContext();
  const { title, description, date, readingTime, authors, tags, permalink, nextItem, prevItem, frontMatter } = metadata;
  const url = `${siteConfig.url}${permalink}`;
  const image = assets.image ?? (frontMatter.image as string | undefined);
  const category = tags[0];
  const minutes = Math.max(1, Math.round(readingTime ?? 1));
  const more = (sidebar?.items ?? []).filter((i) => i.permalink !== permalink).slice(0, 3);
  const showToc = !frontMatter.hide_table_of_contents && toc.length > 2;
  const bodyRef = useRef<HTMLElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const progress = useReadingProgress(bodyRef, minutes);
  const creators = authors
    .map((a) => (a.socials as Record<string, string> | undefined)?.x ?? (a.socials as Record<string, string> | undefined)?.twitter)
    .filter((u): u is string => Boolean(u))
    .map((u) => `@${u.replace(/\/+$/, '').split('/').pop()}`);
  const socialImage = typeof frontMatter.social_image === 'string' ? (frontMatter.social_image as string) : undefined;

  useEffect(() => {
    const links = tocRef.current?.querySelectorAll<HTMLAnchorElement>('a[href^="#"]') ?? [];
    links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${progress.activeId}`));
  }, [progress.activeId]);

  return (
    <main className={clsx('mj-post', !showToc && 'no-toc')}>
      <Head>
        <link rel="alternate" type="text/markdown" href={`${permalink}.md`} title="Markdown version" />
      </Head>
      <SocialMeta
        permalink={permalink}
        title={title}
        image={socialImage}
        imageAlt={`${title}. ${category ? `${category.label} · ` : ''}${minutes} min read. Mercury Blog`}
        labels={[...(category ? [['Topic', category.label] as [string, string]] : []), ['Reading time', `${minutes} min read`]]}
        creators={creators}
        section={category?.label}
        breadcrumbs={[
          { name: 'Mercury', path: '/' },
          { name: 'Blog', path: '/blog' },
          ...(category ? [{ name: category.label, path: category.permalink }] : []),
          { name: title, path: permalink },
        ]}
      />
      <ProgressBar progress={progress} />
      <ContentVisibility metadata={metadata} />
      <header className="mj-post-head">
        <Link to="/blog" className="mj-back">← Blog</Link>
        {category && <Link to={category.permalink} className="mj-post-cat">{category.label}</Link>}
        <h1 className="mj-post-title">{title}</h1>
        {description && <p className="mj-post-dek">{description}</p>}
        <div className="mj-post-byline">
          <div className="mj-post-authors">
            {authors.map((a) => {
              const inner = (
                <>
                  {a.imageURL && <img src={a.imageURL} alt="" width={36} height={36} />}
                  <span>
                    <strong>{a.name}</strong>
                    {a.title && <em>{a.title}</em>}
                  </span>
                </>
              );
              return a.page ? (
                <Link key={a.key ?? a.name} to={a.page.permalink} className="mj-post-author">{inner}</Link>
              ) : (
                <span key={a.key ?? a.name} className="mj-post-author">{inner}</span>
              );
            })}
          </div>
          <div className="mj-meta">
            <time dateTime={date}>{formatDate(date)}</time>
            <span aria-hidden="true">·</span>
            <span>{minutes} min read</span>
          </div>
        </div>
        <ListenPlayer title={title} articleRef={bodyRef} minutes={minutes} />
      </header>

      {image && (
        <div className="mj-post-banner">
          <img src={image} alt="" width={1600} height={900} fetchPriority="high" decoding="async" />
        </div>
      )}

      <div className={clsx('mj-post-layout', showToc && 'has-toc')}>
        {showToc && (
          <aside className="mj-post-toc" aria-label="On this page" ref={tocRef}>
            <div className="mj-toc-head">
              <p>On this page</p>
              <span className="mj-toc-left">{leftLabel(progress)}</span>
            </div>
            <div className="mj-toc-meter" aria-hidden="true"><span style={{ transform: `scaleX(${progress.ratio})` }} /></div>
            <TOCInline toc={toc} maxHeadingLevel={3} />
          </aside>
        )}
        <article className="mj-prose markdown" ref={bodyRef}>
          {children}
        </article>
      </div>

      <footer className="mj-post-foot">
        <ArticleTools permalink={permalink} url={url} title={title} />
        {tags.length > 0 && (
          <div className="mj-post-tags">
            {tags.map((t) => <Link key={t.permalink} to={t.permalink}>{t.label}</Link>)}
          </div>
        )}
        {(prevItem || nextItem) && (
          <nav className="mj-pager" aria-label="More posts">
            {prevItem ? <Link to={prevItem.permalink}><small>Newer</small>{prevItem.title}</Link> : <span />}
            {nextItem ? <Link to={nextItem.permalink} className="is-next"><small>Older</small>{nextItem.title}</Link> : <span />}
          </nav>
        )}
        {more.length > 0 && (
          <section className="mj-more">
            <h2>More from the blog</h2>
            <ul>
              {more.map((i) => (
                <li key={i.permalink}>
                  <Link to={i.permalink}>{i.title}</Link>
                  <time dateTime={new Date(i.date).toISOString()}>{formatDate(i.date)}</time>
                </li>
              ))}
            </ul>
          </section>
        )}
      </footer>
    </main>
  );
}

/** Long-form article page for the Mercury Blog. */
export default function BlogPostPage(props: Props): React.ReactElement {
  const BlogPostContent = props.content;
  return (
    <BlogPostProvider content={props.content} isBlogPostPage>
      <HtmlClassNameProvider className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogPostPage, 'mj-root')}>
        <BlogPostPageMetadata />
        <BlogPostPageStructuredData />
        <Layout>
          <Article sidebar={props.sidebar}>
            <MDXContent>
              <BlogPostContent />
            </MDXContent>
          </Article>
        </Layout>
      </HtmlClassNameProvider>
    </BlogPostProvider>
  );
}
