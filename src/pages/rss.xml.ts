import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import type { APIContext } from "astro";
import { SITE_DESCRIPTION, SITE_TITLE } from "../consts";

export async function GET(context: APIContext) {
  const posts = (
    await getCollection("writing", ({ data }) => !data.draft)
  ).sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());

  return rss({
    title: `${SITE_TITLE} — Writing`,
    description: SITE_DESCRIPTION,
    site: context.site ?? "https://guesser.dev",
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.publishedAt,
      link: `/writing/${post.id}/`,
      categories: post.data.tags,
      author: SITE_TITLE,
    })),
    customData: "<language>en</language>",
  });
}
