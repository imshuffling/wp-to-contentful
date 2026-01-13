# WordPress to Contentful Migration Script

A Node.js script that migrates blog posts from WordPress to Contentful, including featured images, inline images, and Rich Text content conversion.

## Features

✅ **WordPress REST API Integration** - Fetches posts, media, categories, and authors
✅ **Featured Images** - Correctly identifies and migrates WordPress featured images
✅ **Inline Images** - Embeds body content images as Contentful asset blocks in Rich Text
✅ **Rich Text Conversion** - Converts WordPress HTML to Contentful Rich Text format
✅ **Asset Management** - Downloads and uploads images to Contentful
✅ **Author Mapping** - Creates and links Contentful author entries
✅ **Category Support** - Migrates WordPress categories
✅ **Environment Variables** - Secure credential management with `.env`
✅ **Test Mode** - Process a limited number of posts for testing

## Prerequisites

- Node.js and npm installed ([Get npm](https://www.npmjs.com/get-npm))
- WordPress site with REST API enabled
- Contentful space with Content Management API access

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd wp-to-contentful
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your credentials:
   ```env
   # Contentful API Configuration
   CONTENTFUL_ACCESS_TOKEN=your_contentful_access_token
   CONTENTFUL_ENVIRONMENT=master
   CONTENTFUL_SPACE_ID=your_space_id

   # WordPress API Configuration
   WP_ENDPOINT=https://your-wordpress-site.com/wp-json/wp/v2/
   ```

   To get your Contentful credentials:
   - Log into your Contentful space
   - Go to Settings → API keys
   - Create a Content Management API key
   - Copy the Space ID and Content Management Token

## Configuration

### Test Mode

By default, the script processes only a limited number of posts for testing. Edit `migration.js` line 23:

```javascript
const TEST_LIMIT = 2; // Process only 2 posts (for testing)
```

To process all posts:
```javascript
const TEST_LIMIT = null; // Process ALL posts
```

### Content Model Mapping

The script maps WordPress fields to Contentful fields in the `mapData()` function. Review and adjust the `fieldData` object around line 216 to match your Contentful content model:

```javascript
let fieldData = {
  internalName: postData.title.rendered,
  title: postData.title.rendered,
  slug: postData.slug,
  content: postData.content.rendered,
  publishedDate: postData.date_gmt + '+00:00',
  featuredImage: postData.featured_media,
  authorId: postData.author,
  authorName: getAuthorName(postData.author),
  seoTitle: postData.yoast_head_json?.title || postData.title.rendered,
  seoDescription: postData.yoast_head_json?.description || '',
  categories: getPostLabels(postData.categories, 'categories'),
  contentImages: getPostBodyImages(postData)
}
```

## Usage

Run the migration script:

```bash
node migration.js
```

### What Happens During Migration

1. **Fetches WordPress data** - Posts, categories, users, and media from the WordPress REST API
2. **Parses content** - Extracts featured images, inline images, and converts HTML to Rich Text
3. **Creates Contentful assets** - Downloads images and uploads them to Contentful
4. **Creates authors** - Maps WordPress authors to Contentful author entries
5. **Creates posts** - Creates and publishes blog post entries with all linked assets
6. **Publishes entries** - Attempts to publish each entry (or leaves as draft if validation fails)

### Migration Output

The script provides detailed console output showing:
- API fetch progress
- Number of posts being processed (TEST MODE indicator)
- Asset download and upload status
- Author creation status
- Post creation and publishing status
- Any warnings or errors encountered

## Technical Details

### Image Handling

**Featured Images:**
- Uses the `featured_image_url` custom field from WordPress API
- Falls back to `_embedded` media data or global media array
- Ensures featured images are correctly identified and not duplicated in body content
- Handles WordPress image size variations (e.g., `-1024x683` suffixes)

**Inline Images:**
- Converts HTML `<img>` tags to text placeholders during markdown conversion
- Replaces placeholders with Contentful `embedded-asset-block` nodes after Rich Text conversion
- Preserves image order and placement from the original WordPress content

### Content Conversion Pipeline

```
WordPress HTML → Turndown (Markdown) → Rich Text → Embedded Assets → Contentful
```

1. **Turndown** - Converts HTML to Markdown with custom rules for images
2. **Rich Text Conversion** - Uses `@contentful/rich-text-from-markdown`
3. **Asset Embedding** - Custom function replaces image placeholders with embedded asset blocks

## Files Generated

- `wpPosts.json` - Parsed WordPress data (excluded from git)
- `temp_images/` - Temporary directory for downloaded images (excluded from git)
- `*.log` - Migration log files (excluded from git)

## Troubleshooting

### "Could not publish" errors

If posts are created as drafts but not published:
- Check that all required fields in your Contentful content model are being populated
- Review the error details in the console output
- Ensure featured images are being found and linked correctly

### Duplicate entry errors

If you see "Same field value present in other entry":
- Delete existing test entries from Contentful before re-running
- Or modify the `internalName` field to include a timestamp

### Missing images

If images aren't appearing:
- Verify the WordPress site's media URLs are publicly accessible
- Check console warnings for asset matching issues
- Review the `contentImages` array in `wpPosts.json`

## Security Notes

- **Never commit `.env`** - This file contains sensitive credentials and is excluded via `.gitignore`
- **Rotate tokens** - If credentials are exposed, regenerate them in Contentful immediately
- **Use read-only WordPress** - The script only reads from WordPress, but limit API access when possible

## Acknowledgments

Based on the original script by [Jonathan Ashcroft](https://ashcroft.dev/blog/script-migrate-wordpress-posts-contentful/)

Enhanced with:
- Environment variable support for secure credential management
- Improved featured image detection using WordPress custom fields
- Inline image embedding in Rich Text
- Better error handling and validation
- WordPress image size variation handling

## License

MIT
