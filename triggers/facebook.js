const { getCache } = require("actionsflow-core");
const cheerio = require("cheerio");

module.exports = class Facebook {
	options = {};
	helpers;
	cache;

	constructor({ helpers, options }) {
		this.options = options;
		this.helpers = helpers;
		this.cache = getCache(`facebook-trigger`);
	}

	async tryGet(key, getValueFunc) {
		let v = await this.cache.get(key);
		if (!v) {
			v = await getValueFunc();
			this.cache.set(key, v);
		} else if (typeof v === 'string') {
			let parsed;
			try {
				parsed = JSON.parse(v);
			} catch (e) {
				parsed = null;
			}
			if (parsed) {
				v = parsed;
			}
		}

		return v;
	}

	async run() {
		const { page } = this.options;
		let pages = [];

		if (Array.isArray(page)) {
			if (page.length === 0) {
				throw new Error("page must be provided one at lease");
			}
			pages = page;
		} else {
			if (!page) {
				throw new Error("Miss required param page");
			}
			pages = [page];
		}
		this.helpers.log.log("pages:", pages);

		const items = [];

		for (const id of pages) {
			const linkPath = `/${encodeURIComponent(id)}`;

			try {
				const html = await this.fetchPageHtml(linkPath);
				// this.helpers.log.log(`[run][${linkPath}]: html = ${html}`);
				const $ = cheerio.load(html);

				const $recent = $('#recent').first();
				const $items = $recent.find('[data-ft*="story_fbid"]');

				const itemLinks = $('#recent>div>div>div>div:nth-child(2)>div:nth-child(2)>span+a')
					.add('#recent>div>section>article>footer>div>span:nth-child(2)+a')
					.toArray()
					.map((a) => $(a).attr('href'));
				this.helpers.log.log(`page [${id}] found ${$items.length} items`);

				const pageItems = await Promise.all(
					$items.map(async (index, element) => {
						const $item = cheerio.load(element).root();
						const itemLink = $item.find("div:nth-child(2)>div:nth-child(2)>span+a").first().attr("href")
							?? $item.find("footer>div>span:nth-child(2)+a").first().attr("href");

						try {
							if (new RegExp(`^/.+/photos/`).test(itemLink)) {
								// ignore...
								return null;
								// const data = await this.parsePhotoPage(itemLink);
								// return {
								// 	id: this.helpers.createContentDigest(data.url),
								// 	title: data.title,
								// 	link: data.url,
								// 	content: data.content,
								// 	images: [data.image],
								// };
							}

							if (new RegExp(`^/story.php`).test(itemLink)) {
								const data = await this.fetchStoryPage(itemLink);

								return {
									id: this.helpers.createContentDigest(data.url),
									title: data.title,
									link: data.url,
									content: data.content,
									images: data.images.map(img => img.image).filter(img => !!img),
								};
							}

						} catch (error) {
							this.helpers.log.error(`fetch item [${itemLink}] error:`, error);
							const data = await this.parseStoryPage($, $item, itemLink);

							return {
								id: this.helpers.createContentDigest(data.url),
								title: data.title,
								link: data.url,
								content: data.content,
								images: data.images.map(img => img.image).filter(img => !!img),
							};
						}
					})
				);

				pageItems.filter((item) => !!item).forEach(item => {
					items.push(item);
				});
			} catch (e) {
				if (e.code === "ECONNREFUSED") {
					throw new Error(
						`It was not possible to connect to the URL. Please make sure the URL "${page}" it is valid!`
					);
				}

				this.helpers.log.error(`fetch facebook page [${id}] error: `, e);
				throw e;
			}
		}

		// if need
		return items;
	}

	async fetchPageHtml(linkPath) {
		const url = `https://mbasic.facebook.com${linkPath}`;
		const { lang } = this.options;

		this.helpers.log.debug("fetch page html:", url);
		const { data: html } = await this.helpers.axios({
			url,
			responseType: 'text',
			headers: {
				"accept-language": lang || "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6,ja;q=0.5",
				// "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36",
			},
		});
		return html;
	}

	getStoryUrl(linkPath) {
		const { searchParams: q } = new URL('https://mbasic.facebook.com' + linkPath);
		const storyFbId = q.get('story_fbid');
		const storyId = q.get('id');
		const url = `https://www.facebook.com/story.php?story_fbid=${storyFbId}&id=${storyId}`;
		const cacheKey = `story/${storyFbId}/${storyId}`;
		return {
			url,
			cacheKey,
		};
	}

	async fetchStoryPage(linkPath) {
		const { url, cacheKey } = this.getStoryUrl(linkPath);

		/**
		 * @type string
		 */
		const html = await this.tryGet(cacheKey, () => this.fetchPageHtml(linkPath));
		// this.helpers.log.log(`[fetchStoryPage][${linkPath}]: html = ${html}`);
		if (~html.indexOf("You must log in first") || ~html.indexOf("請先登入")) {
			throw new Error(`You must log in first.`);
		}
		if (~html.indexOf("temporarily blocked") || ~html.indexOf("你暫時遭到封鎖")) {
			throw new Error(`You have been temporarily blocked from performing this action.`);
		}

		const $ = cheerio.load(html);
		const $story = $('#m_story_permalink_view');
		const $item = $story.find('[data-ft*="story_fbid"]');
		// const $box = $story.find('[data-ft*="story_fbid"] > div').eq(0);
		const result = await this.parseStoryPage($, $item, linkPath);

		// console.log(`-----------------------------------`);
		// console.log(`$:html`, $.html());
		// console.log(`$story`, $story.length);
		// console.log(`$item`, $item.length);
		// console.log(`$box`, $box.length);
		// console.log(`result`, result);

		if (!result.content) {
			throw new Error(`Page no content`);
		}
		return result;
	}

	/**
	 * @param {cheerio.Root} $
	 * @param {cheerio.Cheerio} $item
	 * @param {string} linkPath
	 */
	async parseStoryPage($, $item, linkPath) {
		const { url, cacheKey } = this.getStoryUrl(linkPath);

		const $box = $item.find('div > div').eq(0);
		const $header = $box.find('> div').eq(0);
		const $content = $box.find('> div').eq(1);
		const $attach = $box.find('> div').eq(2);

		// console.log(`-----------------------------------`);
		// console.log(`$item:html`, $item.html());
		// console.log(`$item`, $item.length);
		// console.log(`$box`, $box.length);
		// console.log(`$header`, $header.length);
		// console.log(`$content`, $content.length);
		// console.log(`$attach`, $attach.length);

		const title = $header.find('h3').text();

		let content = '';
		if ($content.find('p').length === 0) {
			$content.find('br').replaceWith('\n');
			content = $content.text();
		} else {
			const $ps = $content.find('p');
			$ps.find('br').replaceWith('\n');
			content = $ps
				.toArray()
				.map((p) => $(p).text())
				.join('\n');
		}

		const attachList = $attach.find('a');
		const attachLinkList = attachList
			.toArray()
			.map((a) => $(a).attr('href'));
		const attachImgList = attachList
			.find('img')
			.toArray()
			.map((a) => $(a).attr('src'));
		this.helpers.log.log(`page [${cacheKey}] found ${attachLinkList.length} images`);
		this.helpers.log.debug(attachLinkList);
		let images = await Promise.all(attachLinkList.map((link, index) =>
			this.parsePhotoPage(link).catch(reason => {
				this.helpers.log.error(`fetch photo [${linkPath}] error:`, reason);
				return {
					image: attachImgList[index],
				};
			})
		));

		return {
			url,
			title,
			content,
			images: images.filter(item => !!item),
		};
	}

	async parsePhotoPage(linkPath) {
		const { pathname } = new URL('https://mbasic.facebook.com' + linkPath);
		const cacheKey = `photos${pathname}`;

		const html = await this.tryGet(cacheKey, () => this.fetchPageHtml(linkPath));
		const $ = cheerio.load(html);

		const title = $('#MPhotoContent div.msg > a > strong').first().text();
		const url = `https://www.facebook.com${pathname}`;
		const $content = $('#MPhotoContent div.msg > div');
		$content.find('br').replaceWith('\n');
		const content = $content.text();
		const image = $('#MPhotoContent div.desc.attachment > span > div > span > a[target=_blank].sec').attr('href');

		if (!image) {
			throw new Error(`Page no photo`);
		}
		return {
			url,
			title,
			content,
			image,
		};
	}
}
