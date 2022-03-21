import { config } from 'dotenv'; config();

import WebUntis, { Lesson, LoginSessionInformations, ShortData } from "webuntis";
import { WebhookClient, MessageEmbed } from 'discord.js';
import Logger, { LogLevel } from "log75";
import Enmap from 'enmap';

const logger = new Logger(LogLevel.Debug);
let { USERNAME, PASSWORD, SCHOOL, BASEURL, CLASS, GET_CLASSES, DB_DIR, WEBHOOK_ID, WEBHOOK_TOKEN } = process.env;

for (const i of ['USERNAME', 'PASSWORD', 'SCHOOL', 'BASEURL', 'WEBHOOK_ID', 'WEBHOOK_TOKEN']) {
    if (!process.env[i]) {
        logger.error(`$${i} is not set`);
        process.exit(1);
    }
}

const TIMETABLE_DB: Enmap<string, Lesson> = new Enmap({ name: 'timetable', dataDir: DB_DIR });

const whClient = new WebhookClient({ id: WEBHOOK_ID!, token: WEBHOOK_TOKEN! });
const untis = new WebUntis(SCHOOL!, USERNAME!, PASSWORD!, BASEURL!);
let session: LoginSessionInformations|null = null;

const tick = async () => {
    try {
        if (!session) {
            session = await untis.login();
            logger.info(`Logged in with session ${session.sessionId}:\n` +
                `Class ${session.klasseId} / User ${session.personId} (${session.personType})`);

            const classes = await untis.getClasses();

            if (GET_CLASSES == 'true') {
                logger.done(`Available classes:\n`
                    + `${classes.map(c => `${c.id} => ${c.longName} (${c.name}) ${c.active ? '' : '(Inactive)'}`).join('\n')}`);

                process.exit(0);
            }

            if (!CLASS) CLASS = ''+session.klasseId;
            const ownClass = classes.find(c => c.id == Number(CLASS));
            logger.info(`Selected class: ${ownClass?.name} (${ownClass?.id})`);
        }

        logger.info('Fetching timetable');
        const timetable = await untis.getTimetableForRange(
            new Date(Date.now() - (1000 * 60 * 60 * 24)), // 24 hours ago
            new Date(Date.now() + (1000 * 60 * 60 * 24 * 14)), // In 2 weeks
            Number(CLASS),
            WebUntis.TYPES.CLASS,
        );
        logger.done(`Fetched ${timetable.length} items`);

        let newItems = 0;
        for (const item of timetable) {
            if (!TIMETABLE_DB.has(String(item.id))) {
                TIMETABLE_DB.set(String(item.id), item);
                newItems++;
                continue;
            }

            // su -> Subject
            // ro -> Room
            // info -> Info text
            // substText -> Substitution text

            let changed = false;
            const embed = new MessageEmbed();
            const storedItem = TIMETABLE_DB.get(String(item.id))!;
            if (hasChanged(storedItem.su, item.su)) {
                changed = true;
                embed.addField('Old subjects', printShortData(storedItem.su), true);
                embed.addField('New subjects', printShortData(item.su), true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (hasChanged(storedItem.ro, item.ro)) {
                changed = true;
                embed.addField('Old rooms', printShortData(storedItem.ro), true);
                embed.addField('New rooms', printShortData(item.ro), true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (storedItem.info != item.info) {
                changed = true;
                embed.addField('Old info text', storedItem.info || '(None)', true);
                embed.addField('New info text', item.info || '(None)', true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (storedItem.substText != item.substText) {
                changed = true;
                embed.addField('Old substitution text', storedItem.substText || '(None)', true);
                embed.addField('New substitution text', item.substText || '(None)', true);
                embed.addField('\u200b', `\u200b`, true);
            }

            if (changed) {
                logger.info('Timetable update detected');

                const [ year, month, day ] = [
                    Number(String(item.date).substring(0, 4)),
                    Number(String(item.date).substring(4, 6)),
                    Number(String(item.date).substring(6, 8)),
                ];
                const [ startHour, startMin ] = [
                    Number(String(item.startTime).substring(0, 2)),
                    Number(String(item.startTime).substring(2, 4)),
                ];
                const [ endHour, endMin ] = [
                    Number(String(item.endTime).substring(0, 2)),
                    Number(String(item.endTime).substring(2, 4)),
                ];

                const startDate = new Date()
                startDate.setFullYear(year, month-1, day);
                startDate.setHours(startHour);
                startDate.setMinutes(startMin);

                const endDate = new Date()
                startDate.setFullYear(year, month-1, day);
                startDate.setHours(endHour);
                startDate.setMinutes(endMin);

                embed
                    .setTitle('Timetable update')
                    .setColor('#ff6033')
                    .setDescription(
                        `<t:${Math.round(startDate.getTime()/1000)}:D>` +
                        `, from <t:${Math.round(startDate.getTime()/1000)}:t>` +
                        ` until <t:${Math.round(endDate.getTime()/1000)}:t>` +
                        ` (<t:${Math.round(startDate.getTime()/1000)}:R>)`
                    )
                    .setFooter({ text: `Lesson ID: ${item.id}` });

                    await whClient.send({ embeds: [ embed ] });
                    TIMETABLE_DB.set(String(item.id), item);
            }
        }
        
        if (newItems > 0) logger.info(`Discovered ${newItems} new timetable entries`);
    } catch(e) {
        console.error(e);

        // We assume that our session might have gotten revoked
        session = null;
        untis.logout().catch(e => logger.error(e));
    }
}

setInterval(() => tick(), 60000);
tick();

const printShortData = (sub: ShortData[]) => sub
    .map(s => `${s.longname} (${s.name}) (ID: \`${s.id}\`)`)
    .join('\n');

const hasChanged = (a: ShortData[], b: ShortData[]) => {
    return printShortData(a) != printShortData(b);
}
