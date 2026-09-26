<!doctype html>
<html <?php language_attributes(); ?>>
<head><meta charset="<?php bloginfo('charset'); ?>"><?php wp_head(); ?></head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<header class="replica-header">
  <a href="<?php echo esc_url(home_url('/')); ?>"><?php bloginfo('name'); ?></a>
  <button type="button" data-replica-menu-toggle>Menu</button>
  <nav class="replica-menu" data-replica-menu>
    <a href="<?php echo esc_url(home_url('/shop/')); ?>">Shop</a>
    <a href="<?php echo esc_url(wc_get_cart_url()); ?>">Cart <span data-replica-cart-count><?php echo esc_html((string) ((function_exists('WC') && WC()->cart) ? WC()->cart->get_cart_contents_count() : 0)); ?></span></a>
  </nav>
  <?php
  if (function_exists('wc_get_product_id_by_sku')) {
      $fixture_id = wc_get_product_id_by_sku('replica-fixture-001');
      if ($fixture_id) {
          $fixture_url = add_query_arg('add-to-cart', $fixture_id, wc_get_cart_url());
          echo '<a class="replica-fixture-button" data-replica-add-fixture href="' . esc_url($fixture_url) . '">Add fixture</a>';
      }
  }
  ?>
</header>
<script>
document.addEventListener('click',function(e){
  if(e.target && e.target.matches('[data-replica-menu-toggle]')){
    var menu=document.querySelector('[data-replica-menu]');
    if(menu) menu.classList.add('is-open');
  }
});
</script>
<main class="replica-main">
