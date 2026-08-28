import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "zod";

const writing = defineCollection({
  loader: glob({ base: "./src/content/writing", pattern: "**/*.{md,mdx}" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    referenceProject: z
      .object({
        name: z.string(),
        url: z.url(),
        descriptor: z.string().optional(),
      })
      .optional(),
  }),
});

const tdd = defineCollection({
  loader: glob({ base: "./src/content/tdd", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
    package: z.string(),
  }),
});

export const collections = { writing, tdd };
