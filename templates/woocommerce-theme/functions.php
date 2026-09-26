<?php
if (!defined('ABSPATH')) exit;
function replica_woocommerce_setup() { add_theme_support('woocommerce'); add_theme_support('post-thumbnails'); register_nav_menus(['primary'=>'Primary']); }
add_action('after_setup_theme','replica_woocommerce_setup');
function replica_woocommerce_assets() { wp_enqueue_style('replica-style',get_stylesheet_uri(),[], '0.1.0'); }
add_action('wp_enqueue_scripts','replica_woocommerce_assets');
function replica_woocommerce_version() { return '0.1.0'; }
