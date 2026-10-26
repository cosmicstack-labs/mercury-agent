import React from 'react';
import BlogAuthorsListPage from '@theme-original/Blog/Pages/BlogAuthorsListPage';
import type { Props } from '@theme/Blog/Pages/BlogAuthorsListPage';

/**
 * List only authors with at least one published post. Docusaurus lists every
 * author with `page: true`, but only creates pages for authors who have
 * published posts, so an author whose first post is still a draft became a
 * broken link that failed the production build. They appear here as soon as
 * a post of theirs is published.
 */
export default function BlogAuthorsListPageWrapper(props: Props): React.ReactElement {
  return <BlogAuthorsListPage {...props} authors={props.authors.filter((a) => a.count > 0)} />;
}
