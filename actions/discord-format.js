module.exports = (item, username, author, footer) => {
	const payload = {
		"username": username,
		"content": `<${item.link}>`,
		"embeds": [
			{
				"author": author,
				"description": item.content.substr(0, 1000),
				"footer": footer
			}
		]
	};
	if (item.images.length > 0) {
		payload["embeds"][0]["image"] = {
			"url": item.images[0]
		};
		if (item.images.length > 1) {
			payload["embeds"].push(...item.images.slice(1).map(img => ({
				"image": {
					"url": img
				}
			})));
		}
	}
	return payload;
};
