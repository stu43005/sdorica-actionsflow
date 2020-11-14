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
				const $ = cheerio.load(html);

				const itemLinks = $('#recent>div>div>div>div:nth-child(2)>div:nth-child(2)>span+a')
					.toArray()
					.map((a) => $(a).attr('href'));
				this.helpers.log.log(`page [${id}] found ${itemLinks.length} links`);

				const pageItems = await Promise.all(
					itemLinks.map(async (itemLink) => {
						if (new RegExp(`^/.+/photos/`).test(itemLink)) {
							const data = await this.parsePhotoPage(itemLink);
							return {
								id: this.helpers.createContentDigest(data.url),
								title: data.title,
								link: data.url,
								content: data.content,
								images: [data.image],
							};
						}
						if (new RegExp(`^/story.php`).test(itemLink)) {
							const data = await this.parseStoryPage(itemLink);

							return {
								id: this.helpers.createContentDigest(data.url),
								title: data.title,
								link: data.url,
								content: data.content,
								images: data.images.map(img => img.image),
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
				"accept-language": lang || "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6"
			}
		});
		return html;
	}

	async parseStoryPage(linkPath) {
		const { searchParams: q } = new URL('https://mbasic.facebook.com' + linkPath);
		const storyFbId = q.get('story_fbid');
		const storyId = q.get('id');
		const cacheKey = `story/${storyFbId}/${storyId}`;

		const html = await this.tryGet(cacheKey, () => this.fetchPageHtml(linkPath));
		const $ = cheerio.load(html);

		const url = `https://www.facebook.com/story.php?story_fbid=${storyFbId}&id=${storyId}`;
		const $story = $('#m_story_permalink_view').first();
		const $box = $story.find('div > div > div > div').eq(0);
		const $header = $box.find('> div').eq(0);
		const $content = $box.find('> div').eq(1);
		const $attach = $box.find('> div').eq(2);

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

		const attachLinkList = $attach
			.find('a')
			.toArray()
			.map((a) => $(a).attr('href'));
		this.helpers.log.log(`page [${cacheKey}] found ${attachLinkList.length} images`);
		this.helpers.log.debug(attachLinkList);
		let images = await Promise.all(attachLinkList.map((link) => this.parsePhotoPage(link)));

		return {
			url,
			title,
			content,
			images,
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

		return {
			url,
			title,
			content,
			image,
		};
	}
}
