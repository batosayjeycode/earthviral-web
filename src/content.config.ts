import { defineCollection } from 'astro:content';
import { file, glob } from 'astro/loaders';
import { categoryMasterSchema, clusterSchema, countryMasterSchema } from './lib/schemas.ts';

const GENERATED = './src/data/generated';

/** Plan §8.2 — one JSON file per viral cluster, written by the 3-hour batch. */
const clusters = defineCollection({
  loader: glob({ pattern: '**/*.json', base: `${GENERATED}/clusters` }),
  schema: clusterSchema,
});

const countries = defineCollection({
  loader: file(`${GENERATED}/countries-master.json`),
  schema: countryMasterSchema,
});

const categories = defineCollection({
  loader: file(`${GENERATED}/categories-master.json`),
  schema: categoryMasterSchema,
});

export const collections = { clusters, countries, categories };
