// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
	site: 'https://prodeer.github.io',
	integrations: [mdx(), sitemap(), react()],

	server: {
		host: true,
		allowedHosts: true, // 放行所有主机(个人 tailnet 内开发,供 iPad 经 Tailscale 访问)
	},

	vite: {
		plugins: [tailwindcss()],
	},
});
