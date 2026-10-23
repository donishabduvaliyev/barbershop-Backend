# Unit economics: SmartChair (Barbershop OS & Booking SaaS)

Every number below comes from the input file. Nothing is looked up or guessed.

## One shop-month

| line | per shop-month |
| --- | ---: |
| Price | $18.00 |
| Database cluster quota per shop | -$0.50 |
| VPS compute & Socket.io traffic share | -$0.80 |
| SMS gateway & Telegram Bot delivery | -$1.20 |
| **Contribution** (what each shop-month leaves to pay the fixed costs) | **$15.50** (86%) |

## The margin that matters

Fixed costs: $60 a month (Dedicated VPS + MongoDB Atlas baseline cluster $45, Domain, SSL, telemetry & error monitoring $15).

- **Break-even: 1 shop-months a day.** Below that you lose money every month.
- **Profit margin at your plan** (2 a day): **82%** of every sale, after every cost.
- Capacity: 10.0 a day.

## Year 1, month by month

| month | shop-months a day | revenue | profit | cumulative (after $460 startup) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | $178 | $93 | -$367 |
| 2 | 1 | $362 | $252 | -$115 |
| 3 | 1 | $540 | $405 | $290 |
| 4 | 1 | $718 | $558 | $848 |
| 5 | 2 | $902 | $717 | $1,565 |
| 6 | 2 | $1,080 | $870 | $2,435 |
| 7 | 2 | $1,188 | $963 | $3,398 |
| 8 | 2 | $1,296 | $1,056 | $4,454 |
| 9 | 2 | $1,350 | $1,102 | $5,556 |
| 10 | 3 | $1,404 | $1,149 | $6,706 |
| 11 | 3 | $1,458 | $1,196 | $7,901 |
| 12 | 3 | $1,512 | $1,242 | $9,143 |

- **Year 1 operating profit: $9,603** on $11,988 of revenue.
- After the $460 startup spend: $9,143.
- Startup money earned back: month 3.
- Cash you need before it pays for itself: **$460**.

## What if

| scenario | margin at plan | break-even a day | year 1 profit |
| --- | ---: | ---: | ---: |
| Base plan | 82% | 1 | $9,603 |
| Price -10% | 80% | 1 | $8,404 |
| Volume -20% | 81% | 1 | $7,538 |
| Unit costs +15% | 80% | 1 | $9,353 |

No red flags in these numbers. They are only as good as the inputs: check every cost against a real quote.
