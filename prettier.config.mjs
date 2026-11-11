/**
 * prettier.config.mjs — formatting rules for every JS, MJS, JSON and YAML file in this repository.
 *
 * What:    One shared code style so diffs show real changes, not whitespace. A JS file (not
 *          .prettierrc.json) so it can carry this header: Prettier warns on an unknown "$comment" key.
 * How:     Used by `npm run format` (prettier --write .) and `npm run lint` (prettier --check .).
 * Needs:   prettier (devDependency); .prettierignore lists what is never formatted (Markdown, archive/, …).
 * Outputs: Nothing by itself; Prettier reads the exported options.
 */
export default {
  // 100 columns: long enough for the descriptive names used here, short enough for side-by-side diffs.
  printWidth: 100,
  singleQuote: true,
  // Trailing commas everywhere keep one-line diffs when an item is added to a list.
  trailingComma: 'all',
};
