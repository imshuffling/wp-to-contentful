require('dotenv').config();
const contentful = require('contentful-management');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');
const { richTextFromMarkdown } = require('@contentful/rich-text-from-markdown');

// Create a temporary directory for downloaded images
const TEMP_IMAGE_DIR = path.join(__dirname, 'temp_images');
if (!fs.existsSync(TEMP_IMAGE_DIR)) {
  fs.mkdirSync(TEMP_IMAGE_DIR, { recursive: true });
}

/**
 * Global variables that we're going use throughout this script
 * -----------------------------------------------------------------------------
 */

/**
 * TEST MODE: Set to a number to limit how many posts to process (e.g., 2 for testing)
 * Set to null or 0 to process ALL posts
 */
const TEST_LIMIT = 50; // Change this to null when you want to do the full import

/**
 * Main WordPress endpoint - loaded from environment variables
 */
const wpEndpoint = process.env.WP_ENDPOINT;

/**
 * API Endpoints that we'd like to receive data from
 * (e.g. /wp-json/wp/v2/${key})
 */
let wpData = {
  posts: [],
  tags: [],
  categories: [],
  media: [],
  users: [], // Add users for author mapping
};

/**
 * Contentful API requirements - loaded from environment variables
 */
const ctfData = {
  accessToken: process.env.CONTENTFUL_ACCESS_TOKEN,
  environment: process.env.CONTENTFUL_ENVIRONMENT,
  spaceId: process.env.CONTENTFUL_SPACE_ID,
};
Object.freeze(ctfData);

/**
 * Creation of Contentful Client
 */
const ctfClient = contentful.createClient({
  accessToken: ctfData.accessToken,
});

/**
 * Internal: log output separator for terminal.
 */
const logSeparator = `-------`;

/**
 * Object to store WordPress API data in
 */
let apiData = {};

/**
 * Object to store Contentful Data in.
 */
let contentfulData = [];

/**
 * Markdown / Content conversion functions.
 */
const turndownService = new TurndownService({
  codeBlockStyle: 'fenced',
});

/**
 * Convert HTML codeblocks to Markdown codeblocks.
 */
turndownService.addRule('fencedCodeBlock', {
  filter: function (node, options) {
    return (
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild &&
      node.firstChild.nodeName === 'CODE'
    );
  },
  replacement: function (content, node, options) {
    let className = node.firstChild.getAttribute('class') || '';
    let language = (className.match(/language-(\S+)/) || [null, ''])[1];

    return (
      '\n\n' +
      options.fence +
      language +
      '\n' +
      node.firstChild.textContent +
      '\n' +
      options.fence +
      '\n\n'
    );
  },
});

/**
 * Convert inline HTML images to a placeholder that won't be lost during markdown conversion
 * We'll replace these with embedded assets after converting to Rich Text
 */
turndownService.addRule('replaceWordPressImages', {
  filter: ['img'],
  replacement: function (content, node, options) {
    const src = node.getAttribute('src');
    const alt = node.getAttribute('alt') || '';
    const fileName = src.split('/').pop();

    // Use a text placeholder that will survive markdown-to-richtext conversion
    // We'll search for this exact pattern and replace it with embedded assets
    return `\n\n[CONTENTFUL_IMAGE:${fileName}]\n\n`;
  },
});

/**
 * Process Rich Text document to replace image references with embedded assets
 * @param {Object} richTextDoc - The Rich Text document from richTextFromMarkdown
 * @param {Array} assets - Array of Contentful assets with their IDs and filenames
 * @returns {Object} - Modified Rich Text document with embedded assets
 */
function embedAssetsInRichText(richTextDoc, assets) {
  if (!richTextDoc || !richTextDoc.content) {
    return richTextDoc;
  }

  // If assets array is empty, just return the document as-is
  if (!assets || assets.length === 0) {
    console.warn('⚠ No assets available for embedding in Rich Text');
    return richTextDoc;
  }

  const newContent = [];
  let imageMarkerCount = 0;

  for (const node of richTextDoc.content) {
    // Check if this is a paragraph containing our image placeholder text
    if (node.nodeType === 'paragraph' && node.content) {
      let hasImagePlaceholder = false;
      let fileName = null;

      // Look for text nodes containing our placeholder pattern
      for (const childNode of node.content) {
        if (childNode.nodeType === 'text' && childNode.value) {
          // Check for [CONTENTFUL_IMAGE:filename] pattern
          const match = childNode.value.match(/\[CONTENTFUL_IMAGE:([^\]]+)\]/);
          if (match) {
            hasImagePlaceholder = true;
            fileName = match[1];
            imageMarkerCount++;
            break;
          }
        }
      }

      // If we found an image placeholder, replace the paragraph with an embedded asset block
      if (hasImagePlaceholder && fileName) {
        const asset = assets.find((a) => a.fileName === fileName);

        if (asset) {
          // Create an embedded asset block
          newContent.push({
            nodeType: 'embedded-asset-block',
            data: {
              target: {
                sys: {
                  type: 'Link',
                  linkType: 'Asset',
                  id: asset.assetId,
                },
              },
            },
            content: [],
          });
          continue; // Skip adding the original paragraph
        } else {
          console.warn(`⚠ Could not find asset for inline image: ${fileName}`);
          console.warn(
            `  Available assets: ${assets
              .slice(0, 5)
              .map((a) => a.fileName)
              .join(', ')}...`
          );
        }
      }
    }

    // If it's not an image paragraph, or we couldn't convert it, keep the original node
    // But recursively process any nested content
    if (node.content && Array.isArray(node.content)) {
      node.content = embedAssetsInRichText(
        { content: node.content },
        assets
      ).content;
    }

    newContent.push(node);
  }

  if (imageMarkerCount > 0) {
    console.log(`  ✓ Embedded ${imageMarkerCount} inline images in Rich Text`);
  }

  return { ...richTextDoc, content: newContent };
}

/**
 * Main Migration Script.
 * -----------------------------------------------------------------------------
 */

function migrateContent() {
  let promises = [];

  console.log(logSeparator);
  console.log(`Getting WordPress API data`);
  console.log(logSeparator);

  // Loop over our content types and create API endpoint URLs
  for (const [key, value] of Object.entries(wpData)) {
    let wpUrl = `${wpEndpoint}${key}?per_page=100`;
    // Add _embed parameter for posts to get media data
    if (key === 'posts') {
      wpUrl += '&_embed';
    }
    promises.push(wpUrl);
  }

  // console.log('API URLs to fetch:', promises);
  getAllData(promises)
    .then((response) => {
      apiData = response;

      mapData();
    })
    .catch((error) => {
      console.log(error);
    });
}

function getAllData(URLs) {
  return Promise.all(URLs.map(fetchData));
}

function fetchData(URL) {
  return axios
    .get(URL)
    .then(function (response) {
      return {
        success: true,
        endpoint: '',
        data: response.data,
      };
    })
    .catch(function (error) {
      console.error(`Error fetching ${URL}:`, error.message);
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error(`Response:`, error.response.data);
      }
      return { success: false, endpoint: '', error: error.message };
    });
}

/**
 * Get our entire API response and filter it down to only show content that we want to include
 */
function mapData() {
  // Get WP posts from API object

  // Loop over our conjoined data structure and append data types to each child.
  for (const [index, [key, value]] of Object.entries(Object.entries(wpData))) {
    apiData[index].endpoint = key;
  }

  console.log(`Reducing API data to only include fields we want`);
  let apiPosts = getApiDataType('posts')[0];

  // Debug: Check if we got the posts data
  if (!apiPosts || !apiPosts.data) {
    console.error('ERROR: Failed to get posts data from WordPress API');
    console.log('apiPosts:', apiPosts);
    console.log('Full apiData structure:', JSON.stringify(apiData, null, 2));
    throw new Error('No posts data available from WordPress API');
  }

  // Apply TEST_LIMIT if set
  let postsToProcess = apiPosts.data;
  if (TEST_LIMIT && TEST_LIMIT > 0) {
    postsToProcess = apiPosts.data.slice(0, TEST_LIMIT);
    console.log(`TEST MODE: Processing only ${TEST_LIMIT} posts`);
  }

  // Loop over posts - note: we probably /should/ be using .map() here.
  for (let [key, postData] of Object.entries(postsToProcess)) {
    console.log(`Parsing ${postData.slug}`);

    /**
     * Create base object with only limited keys
     * (e.g. just 'slug', 'categories', 'title') etc.
     *
     * The idea here is that the key will be your Contentful field name
     * and the value be the WP post value. We will later match the keys
     * used here to their Contentful fields in the API.
     */
    let fieldData = {
      id: postData.id,
      // type: postData.type,
      internalName: postData.title.rendered,
      title: postData.title.rendered, // Add title field
      slug: postData.slug,
      content: postData.content.rendered,
      publishedDate: postData.date_gmt + '+00:00', // Use publishedDate instead of publishDate
      featuredImage: postData.featured_media,
      authorId: postData.author, // Store author ID
      authorName: getAuthorName(postData.author), // Get author name from ID
      seoTitle: postData.yoast_head_json?.title || postData.title.rendered,
      seoDescription: postData.yoast_head_json?.description || '',
      tags: [...(postData.tags || []), ...(postData.categories || [])], // Combine tag and category IDs for Contentful tags
      categories: postData.categories || [], // Store category IDs separately for reference
      contentImages: getPostBodyImages(postData),
    };

    wpData.posts.push(fieldData);
  }

  console.log(`...Done!`);
  console.log(logSeparator);

  writeDataToFile(wpData, 'wpPosts');
  createForContentful();
}

function getPostBodyImages(postData) {
  // console.log(`- Getting content images`)
  let imageRegex = /<img\s[^>]*?src\s*=\s*['\"]([^'\"]*?)['\"][^>]*?>/g;
  let bodyImages = [];
  let featuredImageUrl = null;

  // First, get the featured image if it exists
  // Try featured_image_url first (custom field provided by this WordPress site)
  if (postData.featured_image_url) {
    featuredImageUrl = postData.featured_image_url;
    bodyImages.push({
      link: featuredImageUrl,
      description:
        postData.yoast_head_json?.og_image?.[0]?.alt || 'Featured image',
      title: postData.title?.rendered || 'Featured image',
      mediaId: postData.featured_media,
      postId: postData.id,
      featured: true,
    });
  } else if (postData.featured_media > 0) {
    // Fallback: try to find it in embedded data or global media array
    console.log(`  Looking for featured_media ID: ${postData.featured_media}`);

    let mediaObj = null;
    if (
      postData._embedded &&
      postData._embedded['wp:featuredmedia'] &&
      postData._embedded['wp:featuredmedia'].length > 0
    ) {
      mediaObj = postData._embedded['wp:featuredmedia'][0];
      console.log(`  ✓ Found featured media in _embedded data`);
    } else {
      // Fallback to searching global media array
      let mediaData = getApiDataType(`media`)[0];
      if (mediaData && mediaData.data) {
        mediaObj = mediaData.data.filter((obj) => {
          if (obj.id === postData.featured_media) {
            return obj;
          }
        })[0];
      }
    }

    if (mediaObj) {
      featuredImageUrl = mediaObj.source_url;
      bodyImages.push({
        link: mediaObj.source_url,
        description: mediaObj.alt_text || 'Featured image',
        title: mediaObj.alt_text || 'Featured image',
        mediaId: mediaObj.id,
        postId: mediaObj.post || postData.id,
        featured: true,
      });
    } else {
      console.log(
        `  ✗ No media object found for featured_media ID ${postData.featured_media}`
      );
    }
  }

  // Then extract body images, but skip the featured image if we find it
  while ((foundImage = imageRegex.exec(postData.content.rendered))) {
    let imageUrl = foundImage[1];

    // Skip this image if it's the featured image (check the base filename)
    if (featuredImageUrl) {
      let featuredFileName = featuredImageUrl.split('/').pop().split('?')[0];
      let currentFileName = imageUrl.split('/').pop().split('?')[0];

      // WordPress often has different sizes of the same image, so check if the base name matches
      if (
        currentFileName.includes(featuredFileName.replace(/\-\d+x\d+/, '')) ||
        featuredFileName.includes(currentFileName.replace(/\-\d+x\d+/, ''))
      ) {
        continue; // Skip this image, it's the featured image
      }
    }

    let alt = postData.id;
    if (foundImage[0].includes('alt="')) {
      alt = foundImage[0].split('alt="')[1].split('"')[0] || '';
    }

    bodyImages.push({
      link: imageUrl,
      description: alt,
      title: alt,
      postId: postData.id,
      featured: false,
    });
  }
  return bodyImages;
}

function getPostLabels(postItems, labelType) {
  let labels = [];
  let apiTag = getApiDataType(labelType)[0];

  for (const labelId of postItems) {
    let labelName = apiTag.data.filter((obj) => {
      if (obj.id === labelId) {
        return obj.name;
      }
    });

    labels.push(labelName[0].name);
  }

  return labels;
}

/**
 * Helper function to get a specific data tree for a type of resource.
 * @param {String} resourceName - specific type of WP endpoint (e.g. posts, media)
 */
function getApiDataType(resourceName) {
  let apiType = apiData.filter((obj) => {
    if (obj.endpoint === resourceName) {
      return obj;
    }
  });
  return apiType;
}

/**
 * Write all exported WP data to its own JSON file.
 * @param {Object} dataTree - JSON body of WordPress data
 * @param {*} dataType - type of WordPress API endpoint.
 */
function writeDataToFile(dataTree, dataType) {
  console.log(`Writing data to a file`);

  fs.writeFile(
    `./${dataType}.json`,
    JSON.stringify(dataTree, null, 2),
    (err) => {
      if (err) {
        console.error(err);
        return;
      }
      console.log(`...Done!`);
      console.log(logSeparator);
    }
  );
}

/**
 * Create Contentful Client.
 */
function createForContentful() {
  ctfClient
    .getSpace(ctfData.spaceId)
    .then((space) => space.getEnvironment(ctfData.environment))
    .then((environment) => {
      buildContentfulAssets(environment);
    })
    .catch((error) => {
      console.log(error);
      return error;
    });
}

/**
 * Get author name from author ID
 * @param {Number} authorId - WordPress author ID
 * @returns {String} - Author name
 */
function getAuthorName(authorId) {
  let usersData = getApiDataType('users')[0];

  if (!usersData || !usersData.data) {
    console.warn(`⚠ No users data available`);
    return null;
  }

  let user = usersData.data.find((user) => user.id === authorId);

  if (user) {
    return user.name;
  }

  console.warn(`⚠ Could not find user with ID: ${authorId}`);
  return null;
}

/**
 * Build data trees for Contentful assets.
 * @param {String} environment - name of Contentful environment.
 */
function buildContentfulAssets(environment) {
  let assetPromises = [];

  console.log('Building Contentful Asset Objects');

  // For every image in every post, create a new asset.
  for (let [index, wpPost] of wpData.posts.entries()) {
    for (const [imgIndex, contentImage] of wpPost.contentImages.entries()) {
      let assetObj = {
        title: {
          'en-GB': contentImage.title,
        },
        description: {
          'en-GB': contentImage.description,
        },
        file: {
          'en-GB': {
            contentType: 'image/jpeg',
            fileName: contentImage.link.split('/').pop(),
            upload: encodeURI(contentImage.link),
          },
        },
      };

      assetPromises.push(assetObj);
    }
  }

  let assets = [];

  console.log(`Creating Contentful Assets...`);
  console.log(logSeparator);

  // getAndStoreAssets()

  createContentfulAssets(environment, assetPromises, assets).then((result) => {
    console.log(`...Done!`);
    console.log(logSeparator);

    getAndStoreAssets(environment, assets);
  });
}

/**
 * Fetch all published assets from Contentful and store in a variable.
 * @param {String} environment - name of Contentful Environment.
 * @param {Array} assets - Array to store assets in.
 */
function getAndStoreAssets(environment, assets) {
  console.log(`Storing asset URLs in a global array to use later`);
  // Not supported with JS? Easier to get all assets and support
  axios
    .get(
      `https://api.contentful.com/spaces/${ctfData.spaceId}/environments/${ctfData.environment}/public/assets`,
      {
        headers: {
          Authorization: `Bearer ${ctfData.accessToken}`,
        },
      }
    )
    .then((result) => {
      // console.log(result)
      contentfulData.assets = [];
      for (const item of result.data.items) {
        contentfulData.assets.push(item.fields.file['en-GB'].url);
      }

      // Create authors first, then posts
      createContentfulAuthors(environment, assets);
    })
    .catch((err) => {
      console.log(err);
      return error;
    });
  console.log(`...Done!`);
  console.log(logSeparator);
}

/**
 * Create Contentful author entries from WordPress users
 * @param {String} environment - Contentful Environment
 * @param {Array} assets - Array of assets (to pass to post creation)
 */
async function createContentfulAuthors(environment, assets) {
  console.log(logSeparator);
  console.log(`Creating Contentful Authors...`);
  console.log(logSeparator);

  // Get unique authors from posts
  const authorIds = [...new Set(wpData.posts.map((post) => post.authorId))];
  const authors = [];

  console.log(`Found ${authorIds.length} unique authors to create`);

  for (const authorId of authorIds) {
    const authorName = getAuthorName(authorId);

    if (!authorName) {
      console.warn(`⚠ Skipping author with ID ${authorId} - no name found`);
      continue;
    }

    try {
      console.log(`Creating author: ${authorName}`);

      const authorEntry = await environment.createEntry('author', {
        fields: {
          name: {
            'en-GB': authorName,
          },
        },
      });

      console.log(`  Created draft author: ${authorName}`);

      // Publish the author
      const publishedAuthor = await authorEntry.publish();
      console.log(`  ✓ Published author: ${authorName}`);

      authors.push({
        authorId: authorId,
        authorName: authorName,
        contentfulId: publishedAuthor.sys.id,
      });

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`❌ Error creating author ${authorName}: ${error.message}`);
    }
  }

  console.log(`Successfully created ${authors.length} authors`);
  console.log(logSeparator);

  // Store authors globally for use in posts
  contentfulData.authors = authors;

  // Now create tags, then posts
  createContentfulTags(environment, assets);
}

/**
 * Create Contentful tag entries from WordPress tags
 * @param {String} environment - Contentful Environment
 * @param {Array} assets - Array of assets (to pass to post creation)
 */
async function createContentfulTags(environment, assets) {
  console.log(logSeparator);
  console.log(
    `Creating Contentful Tags (from WordPress tags and categories)...`
  );
  console.log(logSeparator);

  // Get all unique tag IDs from posts (now includes both tags and categories)
  const allTagIds = wpData.posts.flatMap((post) => post.tags);
  const uniqueTagIds = [...new Set(allTagIds)];
  const tags = [];

  console.log(`Found ${uniqueTagIds.length} unique tags/categories to create`);

  // Get WordPress tag and category data from API
  const wpTags = getApiDataType('tags')[0];
  const wpCategories = getApiDataType('categories')[0];

  if ((!wpTags || !wpTags.data) && (!wpCategories || !wpCategories.data)) {
    console.warn(
      '⚠ No WordPress tag or category data available, skipping tag creation'
    );
    contentfulData.tags = [];
    createContentfulPosts(environment, assets);
    return;
  }

  for (const tagId of uniqueTagIds) {
    // Find the tag name from WordPress data (check both tags and categories)
    let wpItem = null;
    let itemType = '';

    if (wpTags && wpTags.data) {
      wpItem = wpTags.data.find((tag) => tag.id === tagId);
      if (wpItem) itemType = 'tag';
    }

    if (!wpItem && wpCategories && wpCategories.data) {
      wpItem = wpCategories.data.find((cat) => cat.id === tagId);
      if (wpItem) itemType = 'category';
    }

    if (!wpItem || !wpItem.name) {
      console.warn(`⚠ Skipping item with ID ${tagId} - no name found`);
      continue;
    }

    const tagName = wpItem.name;

    try {
      console.log(`Creating tag from WordPress ${itemType}: ${tagName}`);

      const tagEntry = await environment.createEntry('tag', {
        fields: {
          name: {
            'en-GB': tagName,
          },
        },
      });

      console.log(`  Created draft tag: ${tagName}`);

      // Publish the tag
      const publishedTag = await tagEntry.publish();
      console.log(`  ✓ Published tag: ${tagName} (from ${itemType})`);

      tags.push({
        tagId: tagId,
        tagName: tagName,
        contentfulId: publishedTag.sys.id,
      });

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`❌ Error creating tag ${tagName}: ${error.message}`);
    }
  }

  console.log(
    `Successfully created ${tags.length} tags (combined from WordPress tags and categories)`
  );
  console.log(logSeparator);

  // Store tags globally for use in posts
  contentfulData.tags = tags;

  // Now create posts
  createContentfulPosts(environment, assets);
}

/**
 * Download an image from a URL to a local file
 * @param {String} url - Image URL
 * @param {String} filename - Local filename to save to
 * @returns {Promise<String>} - Path to downloaded file
 */
async function downloadImage(url, filename) {
  const filepath = path.join(TEMP_IMAGE_DIR, filename);

  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filepath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Failed to download ${filename}: ${error.message}`);
    throw error;
  }
}

/**
 * Create a Promise to publish all assets.
 * Note that, Timeout might not be needed here, but Contentful
 * rate limits were being hit.
 * @param {String} environment - Contentful Environment
 * @param {Array} promises - Contentful Asset data trees
 * @param {Array} assets - array to store Assets in
 */
async function createContentfulAssets(environment, promises, assets) {
  console.log(`Downloading and creating ${promises.length} assets...`);

  // Create all assets and trigger processing
  const createdAssets = [];
  for (let i = 0; i < promises.length; i++) {
    try {
      const fileName = promises[i].file['en-GB'].fileName;
      const imageUrl = promises[i].file['en-GB'].upload;

      console.log(`[${i + 1}/${promises.length}] Downloading: ${fileName}`);

      // Download the image locally first
      const localPath = await downloadImage(imageUrl, fileName);
      console.log(`  Downloaded to: ${localPath}`);

      // Read the file as a buffer
      const imageBuffer = fs.readFileSync(localPath);

      console.log(`  Uploading to Contentful...`);

      // Upload the file directly to Contentful
      const upload = await environment.createUpload({
        file: imageBuffer,
      });

      // Create asset with the uploaded file
      const assetData = {
        ...promises[i],
        file: {
          'en-GB': {
            contentType: promises[i].file['en-GB'].contentType,
            fileName: fileName,
            uploadFrom: {
              sys: {
                type: 'Link',
                linkType: 'Upload',
                id: upload.sys.id,
              },
            },
          },
        },
      };

      const asset = await environment.createAsset({
        fields: assetData,
      });

      console.log(`  Processing asset...`);
      await asset.processForAllLocales();
      console.log(`✓ Processed: ${fileName}`);
      createdAssets.push(asset);

      // Clean up local file
      fs.unlinkSync(localPath);

      // Small delay to avoid rate limiting
      if (i < promises.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(
        `❌ Error creating asset ${promises[i]?.file?.['en-GB']?.fileName}: ${error.message}`
      );
      // Continue with next asset even if this one fails
    }
  }

  console.log(`Publishing ${createdAssets.length} assets...`);

  // Publish each asset
  for (let i = 0; i < createdAssets.length; i++) {
    try {
      // Fetch the latest version to avoid version conflicts
      const latestAsset = await environment.getAsset(createdAssets[i].sys.id);

      // Check if already published
      if (latestAsset.sys.publishedVersion) {
        console.log(
          `⚠ Asset already published: ${latestAsset.fields.file['en-GB'].fileName}`
        );
        assets.push({
          assetId: latestAsset.sys.id,
          fileName: latestAsset.fields.file['en-GB'].fileName,
        });
      } else {
        // Publish the latest version
        const publishedAsset = await latestAsset.publish();
        console.log(
          `✓ Published: ${publishedAsset.fields.file['en-GB'].fileName}`
        );

        assets.push({
          assetId: publishedAsset.sys.id,
          fileName: publishedAsset.fields.file['en-GB'].fileName,
        });
      }

      // Small delay between publishes
      if (i < createdAssets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(
        `❌ Error publishing asset: ${error.message || JSON.stringify(error)}`
      );
      // Still try to add it in case we can use it
      assets.push({
        assetId: createdAssets[i].sys.id,
        fileName: createdAssets[i].fields.file['en-GB'].fileName,
      });
    }
  }

  console.log(`Successfully processed/stored ${assets.length} assets`);
  return Promise.resolve();
}

/**
 * For each WordPress post, build the data for a Contentful counterpart.
 * @param {String} environment - Name of Contentful Environment.
 * @param {Array} assets - array to store Assets in
 */
async function createContentfulPosts(environment, assets) {
  console.log(`Creating Contentful Posts...`);
  console.log(logSeparator);

  // let postFields = {}
  /**
   * Dynamically build our Contentful data object
   * using the keys we built whilst reducing the WP Post data.alias
   *
   * Results:
   *  postTitle: {
   *    'en-GB': wpPost.postTitle
   *   },
   *  slug: {
   *    'en-GB': wpPost.slug
   *  },
   */
  let promises = [];

  for (const [index, post] of wpData.posts.entries()) {
    let postFields = {};

    for (let [postKey, postValue] of Object.entries(post)) {
      // console.log(`postKey: ${postValue}`)

      // Convert content to Rich Text format for Contentful
      if (postKey === 'content') {
        try {
          // Convert HTML to markdown first
          const markdown = turndownService.turndown(postValue);

          // Convert markdown to proper Contentful Rich Text format
          let richText = await richTextFromMarkdown(markdown);

          // Process the rich text to embed inline images as asset blocks
          postValue = embedAssetsInRichText(richText, assets);
        } catch (error) {
          console.error(
            `❌ Error converting content for post ${post.slug}:`,
            error.message
          );
          // Fall back to a simple paragraph with error message
          postValue = {
            nodeType: 'document',
            data: {},
            content: [
              {
                nodeType: 'paragraph',
                data: {},
                content: [
                  {
                    nodeType: 'text',
                    value: 'Content conversion error. Please check source.',
                    marks: [],
                    data: {},
                  },
                ],
              },
            ],
          };
        }
      }

      // Convert categories array to a single comma-separated string
      if (postKey === 'categories' && Array.isArray(postValue)) {
        postValue = postValue.join(', ');
      }

      /**
       * Remove values/flags/checks used for this script that
       * Contentful doesn't need.
       */
      let keysToSkip = [
        'id',
        'type',
        'contentImages',
        'authorId',
        'authorName',
        'tags', // We handle tags separately with custom linking logic
        'categories', // Categories are now combined with tags
      ];

      if (!keysToSkip.includes(postKey)) {
        postFields[postKey] = {
          'en-GB': postValue,
        };
      }

      // Link author as a reference to the author entry
      if (postKey === 'authorId' && postValue && contentfulData.authors) {
        const authorData = contentfulData.authors.find(
          (a) => a.authorId === postValue
        );

        if (authorData) {
          postFields.author = {
            'en-GB': {
              sys: {
                type: 'Link',
                linkType: 'Entry',
                id: authorData.contentfulId,
              },
            },
          };
          console.log(`✓ Linked author: ${authorData.authorName}`);
        } else {
          console.warn(
            `⚠ Could not find Contentful author for ID: ${postValue}`
          );
        }
      }

      // Link tags as references to tag entries
      if (
        postKey === 'tags' &&
        Array.isArray(postValue) &&
        postValue.length > 0 &&
        contentfulData.tags
      ) {
        const linkedTags = [];

        for (const tagId of postValue) {
          const tagData = contentfulData.tags.find((t) => t.tagId === tagId);

          if (tagData) {
            linkedTags.push({
              sys: {
                type: 'Link',
                linkType: 'Entry',
                id: tagData.contentfulId,
              },
            });
          }
        }

        if (linkedTags.length > 0) {
          postFields.tags = {
            'en-GB': linkedTags,
          };
          console.log(`✓ Linked ${linkedTags.length} tags`);
        }
      }

      if (postKey === 'featuredImage' && postValue > 0) {
        // Check if we have contentImages and assets to work with
        if (
          post.contentImages &&
          post.contentImages.length > 0 &&
          assets.length > 0
        ) {
          // Debug: log contentImages structure
          console.log(
            `  Searching for featured image in ${post.contentImages.length} images`
          );
          console.log(
            `  First image featured flag: ${post.contentImages[0]?.featured}`
          );

          // Find the image marked as featured, not just the first one
          const featuredImageData = post.contentImages.find(
            (img) => img.featured === true
          );

          if (featuredImageData) {
            const targetFileName = featuredImageData.link.split('/').pop();
            let assetObj = assets.find(
              (asset) => asset.fileName === targetFileName
            );

            if (assetObj) {
              postFields.featuredImage = {
                'en-GB': {
                  sys: {
                    type: 'Link',
                    linkType: 'Asset',
                    id: assetObj.assetId,
                  },
                },
              };
              console.log(`✓ Linked featured image: ${targetFileName}`);
            } else {
              console.warn(
                `⚠ Could not find matching asset for: ${targetFileName}`
              );
              console.warn(
                `  Available assets: ${assets
                  .map((a) => a.fileName)
                  .join(', ')}`
              );
            }
          } else {
            console.warn(
              `⚠ No featured image found in contentImages for post: ${post.slug}`
            );
          }
        } else {
          console.warn(
            `⚠ No assets available to link featured image for post: ${post.slug}`
          );
        }
      }

      // No image and Contentful will fail if value is '0', so remove.
      // ALSO remove if the value is still a number (WordPress ID) rather than a Contentful link
      // But only delete if we haven't already set it to a proper Link object above
      if (
        postKey === 'featuredImage' &&
        (postValue === 0 || typeof postValue === 'number')
      ) {
        // Check if we successfully set the featuredImage to a Link object
        if (
          !postFields.featuredImage ||
          !postFields.featuredImage['en-GB']?.sys?.id
        ) {
          delete postFields.featuredImage;
          console.log(`  Removing featuredImage field (no valid asset found)`);
        }
      }
    }
    promises.push(postFields);
  }

  console.log(`Post objects created, attempting to create entries...`);
  createContentfulEntries(environment, promises).then((result) => {
    console.log(logSeparator);
    console.log(`Done!`);
    console.log(logSeparator);
    console.log(`The migration has completed.`);
    console.log(logSeparator);
  });
}

/**
 * For each post data tree, publish a Contentful entry.
 * @param {String} environment - Name of Contentful Environment.
 * @param {Array} promises - data trees for Contentful posts.
 */
function createContentfulEntries(environment, promises) {
  return Promise.all(
    promises.map(
      (post, index) =>
        new Promise(async (resolve) => {
          let newPost;

          console.log(`Attempting: ${post.slug['en-GB']}`);

          setTimeout(() => {
            try {
              newPost = environment
                .createEntry('pageBlogPost', {
                  fields: post,
                })
                .then((entry) => {
                  console.log(`Created draft: ${entry.fields.slug['en-GB']}`);

                  // Try to publish, but if it fails due to missing required fields, leave as draft
                  return entry
                    .publish()
                    .then((published) => {
                      console.log(
                        `Published: ${published.fields.slug['en-GB']}`
                      );
                      return published;
                    })
                    .catch((publishError) => {
                      console.log(
                        `Could not publish ${entry.fields.slug['en-GB']} - left as draft. Error: ${publishError.message}`
                      );
                      return entry;
                    });
                });
            } catch (error) {
              throw Error(error);
            }

            resolve(newPost);
          }, 1000 + 5000 * index);
        })
    )
  );
}

/**
 * Convert WordPress content to Contentful Rich Text
 * Ideally we'd be using Markdown here, but I like the RichText editor 🤡
 *
 * Note: Abandoned because it did not seem worth the effort.
 * Leaving this here in case anybody does decide to venture this way.
 *
 * @param {String} content - WordPress post content.
 */
function formatRichTextPost(content) {
  // TODO: split  at paragraphs, create a node for each.
  console.log(logSeparator);

  // turndownService.remove('code')
  let markdown = turndownService.turndown(content);

  // console.log(logSeparator)
  // console.log(markdown)

  // let imageLinks = /!\[[^\]]*\]\((.*?)\s*("(?:.*[^"])")?\s*\)/g
  // let imageRegex = /<img\s[^>]*?src\s*=\s*['\"]([^'\"]*?)['\"][^>]*?>/g

  // while (foundImage = imageLinks.exec(markdown)) {
  // console.log(foundImage[0])
  // let alt = foundImage[0].split('alt="')[1].split('"')[0]
  // }

  /**
   * https://www.contentful.com/developers/docs/concepts/rich-text/
   */

  /**
   *     "expected": [
          "blockquote",
          "embedded-asset-block",
          "embedded-entry-block",
          "heading-1",
          "heading-2",
          "heading-3",
          "heading-4",
          "heading-5",
          "heading-6",
          "hr",
          "ordered-list",
          "paragraph",
          "unordered-list"
        ]
   */

  // let contentor = {
  //   content: [
  //     {
  //       nodeType:"paragraph",
  //       data: {},
  //       content: [
  //         {
  //           value: content,
  //           nodeType:"text",
  //           marks: [],
  //           data: {}
  //         }
  //       ]
  //     },
  //     // {
  //     //   nodeType:"paragraph",
  //     //   data: {},
  //     //   content: [
  //     //     {
  //     //       value: "lorem hello world two",
  //     //       nodeType:"text",
  //     //       marks: [],
  //     //       data: {}
  //     //     }
  //     //   ]
  //     // },
  //   ],
  //   data: {},
  //   nodeType: 'document'
  // };

  return markdown;
}

migrateContent();
