<?php
get_header();
while (have_posts()) {
    the_post();
    ?>
    <article <?php post_class('replica-page'); ?>>
      <h1><?php the_title(); ?></h1>
      <div class="replica-page-content"><?php the_content(); ?></div>
    </article>
    <?php
}
get_footer();
